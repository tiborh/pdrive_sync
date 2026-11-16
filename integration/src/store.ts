import { Database } from "bun:sqlite";
import { mkdirSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { DriveEventType, type DriveEvent } from "@protontech/drive-sdk";

export class IntegrationBlockedError extends Error {}

export class EventStore {
  private readonly db: Database;

  constructor(
    filename: string,
    readonly scope: string,
    readonly root: string,
  ) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(filename)).isSymbolicLink()) {
      throw new Error("Event-state directory must not be a symlink.");
    }
    try {
      if (lstatSync(filename).isSymbolicLink()) {
        throw new Error("Event-state file must not be a symlink.");
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    this.db = new Database(filename);
    try {
      this.db.run("PRAGMA busy_timeout = 1000");
      this.db.run("PRAGMA synchronous = FULL");
      this.db.run("PRAGMA locking_mode = EXCLUSIVE");
      this.db.run("BEGIN EXCLUSIVE");
      this.db.run("COMMIT");
      this.db.run(
        "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      this.db.run(
        "CREATE TABLE IF NOT EXISTS known_nodes (uid TEXT PRIMARY KEY)",
      );
      this.db.run(
        `CREATE TABLE IF NOT EXISTS events (
          event_id TEXT NOT NULL, type TEXT NOT NULL, node_uid TEXT NOT NULL,
          PRIMARY KEY (event_id, type, node_uid))`,
      );
      if (this.get("scope")) {
        if (this.get("scope") !== scope || this.get("root") !== root) {
          throw new Error(
            "Event state belongs to a different scope or folder.",
          );
        }
      } else {
        this.db.transaction(() => {
          this.set("scope", scope);
          this.set("root", root);
        })();
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private get(key: string): string | undefined {
    return this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM metadata WHERE key = ?",
      )
      .get(key)?.value;
  }

  private set(key: string, value: string): void {
    this.db.run("INSERT OR REPLACE INTO metadata VALUES (?, ?)", [key, value]);
  }

  get cursor(): string | undefined {
    return this.get("cursor");
  }

  get initialized(): boolean {
    return this.get("initialized") === "yes";
  }

  get blocked(): string | undefined {
    return this.get("blocked");
  }

  seed(uids: string[]): void {
    this.db.transaction(() => {
      for (const uid of uids) {
        this.db.run("INSERT OR IGNORE INTO known_nodes VALUES (?)", [uid]);
      }
      this.set("initialized", "yes");
    })();
  }

  record(event: DriveEvent): boolean {
    if (
      event.type === DriveEventType.TreeRefresh ||
      event.type === DriveEventType.TreeRemove ||
      (event.type === DriveEventType.NodeDeleted && event.nodeUid === this.root)
    ) {
      this.set("blocked", event.type);
      throw new IntegrationBlockedError(
        `Integration stopped: ${event.type}; a fresh snapshot or access recovery is required.`,
      );
    }
    if (!("nodeUid" in event)) {
      return false;
    }
    const known = this.db
      .query<{ uid: string }, [string]>(
        "SELECT uid FROM known_nodes WHERE uid = ?",
      )
      .get(event.nodeUid);
    if (
      event.nodeUid !== this.root &&
      event.parentNodeUid !== this.root &&
      !known
    ) {
      return false;
    }
    return this.db.transaction(() => {
      if (
        event.nodeUid !== this.root &&
        (event.type === DriveEventType.NodeDeleted ||
          event.isTrashed ||
          (event.parentNodeUid !== undefined &&
            event.parentNodeUid !== this.root))
      ) {
        this.db.run("DELETE FROM known_nodes WHERE uid = ?", [event.nodeUid]);
      } else {
        this.db.run("INSERT OR IGNORE INTO known_nodes VALUES (?)", [
          event.nodeUid,
        ]);
      }
      const result = this.db.run(
        "INSERT OR IGNORE INTO events VALUES (?, ?, ?)",
        [event.eventId, event.type, event.nodeUid],
      );
      return result.changes > 0;
    })();
  }

  checkpoint(cursor: string): void {
    if (this.blocked) {
      throw new IntegrationBlockedError(this.blocked);
    }
    this.set("cursor", cursor);
  }

  get eventCount(): number {
    const result = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
      .get();
    if (!result) {
      throw new Error("Could not read the durable event count.");
    }
    return result.count;
  }

  close(): void {
    this.db.close();
  }
}
