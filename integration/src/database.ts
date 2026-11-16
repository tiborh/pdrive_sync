import { Database } from "bun:sqlite";
import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openStateDatabase(filename: string): Database {
  const absolute = resolve(filename);
  let directory = dirname(absolute);
  while (true) {
    try {
      if (lstatSync(directory).isSymbolicLink()) {
        throw new Error("Event/planner state must not traverse symlinks.");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  try {
    closeSync(
      openSync(
        absolute,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      ),
    );
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const info = lstatSync(absolute);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("State must be a private regular file owned by you.");
  }
  const db = new Database(absolute);
  try {
    db.run("PRAGMA busy_timeout = 1000");
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    db.run("BEGIN EXCLUSIVE");
    db.run("COMMIT");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}
