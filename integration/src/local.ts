import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Entry } from "./metadata.ts";
import { isMissing } from "./database.ts";

export function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export async function inspectLocal(
  path: string,
  copyTo?: FileHandle,
): Promise<Entry | undefined> {
  let info: BigIntStats;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (info.isDirectory()) return { kind: "directory" };
  if (!info.isFile()) {
    return {
      kind: "unsupported",
      issue: info.isSymbolicLink()
        ? "Local symlink is not followed"
        : "Unsupported local special file",
    };
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!sameFile(info, await file.stat({ bigint: true }))) {
      throw new Error(
        `Local file changed while opening: ${JSON.stringify(path)}`,
      );
    }
    const hash = createHash("sha1");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      if (copyTo) await copyTo.writeFile(chunk);
    }
    if (
      !sameFile(info, await file.stat({ bigint: true })) ||
      !sameFile(info, await lstat(path, { bigint: true }))
    ) {
      throw new Error(
        `Local file changed while hashing: ${JSON.stringify(path)}`,
      );
    }
    const size = Number(info.size);
    if (!Number.isSafeInteger(size))
      throw new Error("Local file is too large to represent safely.");
    return { kind: "file", size, sha1: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

export async function localRoot(path: string): Promise<{
  path: string;
  identity: string;
}> {
  const absolute = resolve(path);
  const info = await lstat(absolute, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("--local must be an existing directory, not a symlink.");
  }
  const canonical = await realpath(absolute);
  return { path: canonical, identity: `${info.dev}:${info.ino}` };
}

export async function scanLocal(root: string): Promise<Map<string, Entry>> {
  const result = new Map<string, Entry>();
  const directories: { path: string; info: BigIntStats }[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || (await realpath(directory)) !== directory) {
      throw new Error(
        "Local directory changed or became a symlink during scan.",
      );
    }
    directories.push({ path: directory, info: before });
    for (const item of await readdir(directory, { encoding: "buffer" })) {
      if (!isUtf8(item)) {
        throw new Error(
          "Local filename is not valid UTF-8; no complete plan is possible.",
        );
      }
      const name = item.toString("utf8");
      const path = resolve(directory, name);
      const key = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path, { bigint: true });
      if (info.isDirectory()) {
        result.set(key, { kind: "directory" });
        await visit(path, key);
      } else {
        const entry = await inspectLocal(path);
        if (!entry) throw new Error("Local entry disappeared during scan.");
        result.set(key, entry);
      }
    }
  };
  await visit(root, "");
  for (const directory of directories) {
    if (
      !sameFile(directory.info, await lstat(directory.path, { bigint: true }))
    ) {
      throw new Error(
        "Local directory changed during scan; retry with a quiescent tree.",
      );
    }
  }
  return result;
}
