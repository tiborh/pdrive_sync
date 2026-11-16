import type { Database } from "bun:sqlite";
import { openStateDatabase } from "./database.ts";
import type { Agreement, RemoteNode } from "./metadata.ts";

type RemoteRow = {
  uid: string;
  parent: string;
  name: string;
  kind: RemoteNode["kind"];
  size: number | null;
  sha1: string | null;
  revision: string | null;
  verification: RemoteNode["verification"] | null;
  issue: string | null;
};

export type RootBinding = {
  local: string;
  localIdentity: string;
  remote: string;
  rootUid: string;
  scope: string;
};

export class ReconcileStore {
  private readonly db: Database;

  constructor(filename: string, binding: RootBinding) {
    this.db = openStateDatabase(filename);
    try {
      this.db.run(
        "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      const kind = this.get("kind");
      if (!kind && this.db.query("SELECT key FROM metadata LIMIT 1").get()) {
        throw new Error(
          "Use a separate planner database, not an event-journal state file.",
        );
      }
      if (kind && kind !== "reconcile-v1") {
        throw new Error("Unsupported planner state schema.");
      }
      const expected = JSON.stringify(binding);
      if (kind && this.get("binding") !== expected) {
        throw new Error(
          "Planner state belongs to different roots, account scope, or local directory identity.",
        );
      }
      this.db.run(`CREATE TABLE IF NOT EXISTS remote_nodes (
        uid TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        size INTEGER, sha1 TEXT, revision TEXT, verification TEXT, issue TEXT)`);
      this.db.run(
        "CREATE TABLE IF NOT EXISTS agreements (path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, remote_uid TEXT NOT NULL)",
      );
      if (!kind) {
        this.db.transaction(() => {
          this.set("kind", "reconcile-v1");
          this.set("binding", expected);
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

  get blocked(): string | undefined {
    return this.get("blocked");
  }

  block(reason: string): never {
    this.set("blocked", reason);
    throw new Error(
      `Reconciliation blocked: ${reason}. Preserve state and recover access or explicitly bootstrap a new state file.`,
    );
  }

  nodes(): Map<string, RemoteNode> {
    return new Map(
      this.db
        .query<RemoteRow, []>("SELECT * FROM remote_nodes")
        .all()
        .map((row) => [
          row.uid,
          {
            uid: row.uid,
            parentUid: row.parent,
            name: row.name,
            kind: row.kind,
            size: row.size ?? undefined,
            sha1: row.sha1 ?? undefined,
            revision: row.revision ?? undefined,
            verification: row.verification ?? undefined,
            issue: row.issue ?? undefined,
          },
        ]),
    );
  }

  agreements(): Map<string, Agreement> {
    return new Map(
      this.db
        .query<{ path: string; fingerprint: string; remote_uid: string }, []>(
          "SELECT * FROM agreements",
        )
        .all()
        .map((row) => [
          row.path,
          { fingerprint: row.fingerprint, remoteUid: row.remote_uid },
        ]),
    );
  }

  commit(
    nodes: ReadonlyMap<string, RemoteNode>,
    cursor: string,
    agreements: ReadonlyMap<string, Agreement>,
  ): void {
    if (this.blocked)
      throw new Error(`Reconciliation remains blocked: ${this.blocked}`);
    this.db.transaction(() => {
      this.db.run("DELETE FROM remote_nodes");
      const insert = this.db.query(
        "INSERT INTO remote_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const node of nodes.values()) {
        insert.run(
          node.uid,
          node.parentUid,
          node.name,
          node.kind,
          node.size ?? null,
          node.sha1 ?? null,
          node.revision ?? null,
          node.verification ?? null,
          node.issue ?? null,
        );
      }
      for (const [path, agreement] of agreements) {
        this.db.run("INSERT OR REPLACE INTO agreements VALUES (?, ?, ?)", [
          path,
          agreement.fingerprint,
          agreement.remoteUid,
        ]);
      }
      this.set("cursor", cursor);
    })();
  }

  close(): void {
    this.db.close();
  }
}
