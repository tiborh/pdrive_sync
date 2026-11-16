import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fingerprint, validateName, type Entry } from "./metadata.ts";
import { inspectLocal, localRoot } from "./local.ts";
import type { TransferIntent } from "./reconcile-store.ts";
import { isMissing } from "./database.ts";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function operationDirectory(state: string): Promise<string> {
  const base = `${resolve(state)}.files`;
  await mkdir(base, { mode: 0o700, recursive: true });
  const info = await lstat(base);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Recovery directory must be private, owned by you, and not a symlink.",
    );
  }
  await syncDirectory(dirname(base));
  const directory = await mkdtemp(join(base, "transfer-"));
  await syncDirectory(base);
  return directory;
}

export async function saveIntent(intent: TransferIntent): Promise<void> {
  const file = await open(join(intent.artifact, "operation.json"), "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(intent, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(intent.artifact);
}

export class LocalAccess {
  private constructor(
    private readonly root: string,
    private readonly identity: string,
    private readonly handle: FileHandle,
  ) {}

  static async create(root: string, identity: string): Promise<LocalAccess> {
    const handle = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const info = await handle.stat({ bigint: true });
    if (`${info.dev}:${info.ino}` !== identity) {
      await handle.close();
      throw new Error("Local root changed before applying.");
    }
    return new LocalAccess(root, identity, handle);
  }

  async parent(path: string) {
    const components = path.split("/");
    for (const component of components) validateName(component);
    const name = components.pop();
    if (!name) throw new Error("A file/directory path is required.");
    const handles: FileHandle[] = [];
    let handle = this.handle;
    try {
      for (const component of components) {
        handle = await open(
          `/proc/self/fd/${handle.fd}/${component}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        handles.push(handle);
      }
      const directory = `/proc/self/fd/${handle.fd}`;
      const assertCurrent = async () => {
        if (
          (await localRoot(this.root)).identity !== this.identity ||
          (await realpath(directory)) !== resolve(this.root, dirname(path))
        ) {
          throw new Error(
            "Local root or parent directory moved during synchronization.",
          );
        }
      };
      await assertCurrent();
      return {
        path: `${directory}/${name}`,
        directory,
        handle,
        assertCurrent,
        close: async () => {
          for (const item of handles.reverse()) await item.close();
        },
      };
    } catch (error) {
      for (const item of handles.reverse()) await item.close();
      throw error;
    }
  }

  async inspect(path: string): Promise<Entry | undefined> {
    try {
      const parent = await this.parent(path);
      try {
        return await inspectLocal(parent.path);
      } finally {
        await parent.close();
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async install(
    path: string,
    stage: string,
    artifact: string,
    before: Entry | undefined,
    target: Entry,
  ): Promise<void> {
    const parent = await this.parent(path);
    let moved = false;
    const backup = join(artifact, "original");
    try {
      if ((await parent.handle.stat()).dev !== (await lstat(artifact)).dev) {
        throw new Error(
          "Recovery staging and destination must be on the same filesystem.",
        );
      }
      const current = await inspectLocal(parent.path);
      if (
        (current ? fingerprint(current) : null) !==
        (before ? fingerprint(before) : null)
      ) {
        throw new Error("Local destination changed before installation.");
      }
      await parent.assertCurrent();
      if (before) {
        const placeholder = await open(backup, "wx", 0o600);
        await placeholder.close();
        await rename(parent.path, backup);
        moved = true;
        await syncDirectory(artifact);
        await parent.handle.sync();
        if (
          fingerprint(
            (await inspectLocal(backup)) ?? { kind: "unsupported" },
          ) !== fingerprint(before)
        ) {
          throw new Error(
            "Local destination changed at replacement; its latest version was preserved.",
          );
        }
      }
      await parent.assertCurrent();
      await link(stage, parent.path);
      await parent.handle.sync();
      if (
        fingerprint(
          (await inspectLocal(parent.path)) ?? { kind: "unsupported" },
        ) !== fingerprint(target)
      ) {
        throw new Error("Installed file changed before acknowledgement.");
      }
    } catch (error) {
      if (moved) {
        try {
          await parent.assertCurrent();
          await link(backup, parent.path);
          await parent.handle.sync();
        } catch (restoreError) {
          throw new Error(
            `${errorMessage(error)} Recovery retained at ${artifact}; exclusive restoration failed: ${errorMessage(restoreError)}`,
          );
        }
      }
      throw error;
    } finally {
      await parent.close();
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
