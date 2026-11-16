import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RevisionState,
  type FileUploader,
  type NodeOrUid,
  type Revision,
  type UploadMetadata,
} from "@protontech/drive-sdk";
import { synchronize, type TransferClient } from "../src/sync.ts";
import { prepareReconciliation, reconcile } from "../src/reconcile.ts";
import { FakeSdk, changed, node, root, sha1 } from "./fixtures.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pdrive-sync-test-"));
  directories.push(directory);
  const local = join(directory, "local");
  mkdirSync(local);
  return {
    directory,
    local,
    state: join(directory, "plan.sqlite"),
    remote: "/my-files/test",
    privateDirectories: [],
  };
}
const uidOf = (value: NodeOrUid) =>
  typeof value === "string" ? value : value.uid;
class TransferSdk extends FakeSdk implements TransferClient {
  history = new Map<string, Revision[]>();
  mutations = 0;
  failures = new Set<string>();
  beforeUpload?: () => void;
  afterUpload?: () => void;
  afterDownload?: () => void;
  put(uid: string, parent: string, name: string, content: string) {
    const file = node(uid, parent, name, content);
    if (!file.activeRevision) throw new Error("Missing synthetic revision");
    const revision = {
      ...file.activeRevision,
      uid: `${uid}-revision-${++this.mutations}`,
    };
    file.activeRevision = revision;
    this.nodes.set(uid, file);
    const previous = this.history.get(uid) ?? [];
    this.history.set(uid, [
      revision,
      ...previous.map((old) => ({ ...old, state: RevisionState.Superseded })),
    ]);
    this.revisionBytes.set(revision.uid, new TextEncoder().encode(content));
    this.events.push(changed(uid, parent, String(this.mutations)));
    return file;
  }
  override async getFileRevisionDownloader(revision: string) {
    const downloader = await super.getFileRevisionDownloader(revision);
    return {
      ...downloader,
      downloadToStream: (stream: WritableStream) => {
        const controller = downloader.downloadToStream(stream);
        return {
          ...controller,
          completion: async () => {
            await controller.completion();
            this.afterDownload?.();
          },
        };
      },
    };
  }
  async *iterateRevisions(value: NodeOrUid) {
    yield* this.history.get(uidOf(value)) ?? [];
  }
  async createFolder(parent: NodeOrUid, name: string) {
    if (
      [...this.nodes.values()].some(
        (entry) =>
          entry.parentUid === uidOf(parent) &&
          entry.name.ok &&
          entry.name.value === name,
      )
    )
      throw new Error("Name conflict");
    const folder = node(`folder-${++this.mutations}`, uidOf(parent), name);
    this.nodes.set(folder.uid, folder);
    this.events.push(
      changed(folder.uid, uidOf(parent), String(this.mutations)),
    );
    return folder;
  }
  private uploader(
    parent: string,
    name: string,
    metadata: UploadMetadata,
    existing?: string,
  ): FileUploader {
    return {
      uploadFromStream: async (stream) => ({
        pause() {},
        resume() {},
        completion: async () => {
          const text = await new Response(stream).text();
          if (
            Buffer.byteLength(text) !== metadata.expectedSize ||
            sha1(text) !== metadata.expectedSha1
          )
            throw new Error("Upload integrity failure");
          this.beforeUpload?.();
          if (this.failures.has(name))
            throw new Error("Synthetic upload failure");
          if (
            !existing &&
            [...this.nodes.values()].some(
              (entry) =>
                entry.parentUid === parent &&
                entry.name.ok &&
                entry.name.value === name,
            )
          )
            throw new Error("Name conflict");
          const file = this.put(
            existing ?? `uploaded-${this.mutations}`,
            parent,
            name,
            text,
          );
          this.afterUpload?.();
          if (!file.activeRevision) throw new Error("Missing receipt");
          return {
            nodeUid: file.uid,
            nodeRevisionUid: file.activeRevision.uid,
          };
        },
      }),
      uploadFromFile() {
        throw new Error("Use the staged stream");
      },
    };
  }
  async getFileUploader(
    parent: NodeOrUid,
    name: string,
    metadata: UploadMetadata,
  ) {
    return this.uploader(uidOf(parent), name, metadata);
  }
  async getFileRevisionUploader(value: NodeOrUid, metadata: UploadMetadata) {
    const file = await this.getNode(value);
    if (!file.parentUid || !file.name.ok)
      throw new Error("Invalid synthetic file");
    return this.uploader(file.parentUid, file.name.value, metadata, file.uid);
  }
}

test("one-shot sync creates both directory trees and transfers nested/empty/Unicode files exactly once", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  mkdirSync(join(config.local, "up"));
  mkdirSync(join(config.local, "empty-local"));
  writeFileSync(join(config.local, "up/árvíz.txt"), "upload\n");
  sdk.nodes.set("down", node("down", "root", "down"));
  sdk.put("empty", "down", ".empty", "");
  const result = await synchronize(sdk, root, config);
  expect(result.results.every((item) => item.status === "completed")).toBe(
    true,
  );
  expect(readFileSync(join(config.local, "down/.empty"), "utf8")).toBe("");
  expect(
    [...sdk.nodes.values()].some(
      (item) => item.name.ok && item.name.value === "árvíz.txt",
    ),
  ).toBe(true);
  const mutations = sdk.mutations;
  const again = await synchronize(sdk, root, config);
  expect(again.results.every((item) => item.status === "unchanged")).toBe(true);
  expect(sdk.mutations).toBe(mutations);
  expect(result.pending).toEqual([]);
});

test("changed uploads retain prior revisions; staged download replacements retain original local bytes", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  const previous = sdk.put("up", "root", "upload", "before");
  sdk.put("down", "root", "download", "before");
  writeFileSync(join(config.local, "upload"), "before");
  writeFileSync(join(config.local, "download"), "before");
  await reconcile(sdk, root, config);
  writeFileSync(join(config.local, "upload"), "new upload");
  sdk.put("down", "root", "download", "new download");
  const result = await synchronize(sdk, root, config);
  expect(result.summary.completed).toBe(2);
  expect(readFileSync(join(config.local, "download"), "utf8")).toBe(
    "new download",
  );
  const downloaded = result.results.find((item) => item.path === "download");
  expect(downloaded?.recovery).toBeDefined();
  expect(
    readFileSync(join(downloaded?.recovery ?? "", "original"), "utf8"),
  ).toBe("before");
  expect(
    sdk.history
      .get("up")
      ?.some((revision) => revision.uid === previous.activeRevision?.uid),
  ).toBe(true);
  expect(
    (await reconcile(sdk, root, config)).items.every(
      (item) => item.action === "unchanged",
    ),
  ).toBe(true);
});

test("conflicts, missing entries, and unsupported files are untouched while independent transfers succeed", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  sdk.put("conflict", "root", "conflict", "base");
  sdk.put("missing", "root", "missing", "base");
  writeFileSync(join(config.local, "conflict"), "base");
  writeFileSync(join(config.local, "missing"), "base");
  await reconcile(sdk, root, config);
  writeFileSync(join(config.local, "conflict"), "local conflict");
  sdk.put("conflict", "root", "conflict", "remote conflict");
  rmSync(join(config.local, "missing"));
  symlinkSync("../outside", join(config.local, "link"));
  writeFileSync(join(config.local, "safe"), "safe");
  const result = await synchronize(sdk, root, config);
  expect(result.summary.skipped).toBe(3);
  expect(result.summary.completed).toBe(1);
  expect(readFileSync(join(config.local, "conflict"), "utf8")).toBe(
    "local conflict",
  );
  expect(sdk.history.get("conflict")).toHaveLength(2);
  expect(readdirSync(config.local).includes("missing")).toBe(false);
  expect(result.deletionPropagation).toBe(false);
});

test("failed signature verification never replaces the local destination and other operations still complete", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  sdk.put("f", "root", "download", "before");
  writeFileSync(join(config.local, "download"), "before");
  await reconcile(sdk, root, config);
  sdk.put("f", "root", "download", "after");
  sdk.failVerification = true;
  writeFileSync(join(config.local, "upload"), "independent");
  const result = await synchronize(sdk, root, config);
  expect(result.summary.failed).toBe(1);
  expect(result.summary.completed).toBe(1);
  expect(readFileSync(join(config.local, "download"), "utf8")).toBe("before");
});

test("a local edit during download is preserved rather than overwritten", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  sdk.put("f", "root", "file", "before");
  writeFileSync(join(config.local, "file"), "before");
  await reconcile(sdk, root, config);
  sdk.put("f", "root", "file", "remote changed");
  sdk.afterDownload = () =>
    writeFileSync(join(config.local, "file"), "racing local edit");
  const result = await synchronize(sdk, root, config);
  expect(result.results[0]?.status).toBe("failed");
  expect(readFileSync(join(config.local, "file"), "utf8")).toBe(
    "racing local edit",
  );
});

test("upload source changes and remote name collisions preserve both versions and report failure", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  writeFileSync(join(config.local, "upload"), "planned content");
  sdk.afterUpload = () =>
    writeFileSync(join(config.local, "upload"), "later local edit");
  const result = await synchronize(sdk, root, config);
  expect(result.summary.failed).toBe(1);
  expect(readFileSync(join(config.local, "upload"), "utf8")).toBe(
    "later local edit",
  );
  expect(
    readFileSync(join(result.results[0]?.recovery ?? "", "incoming"), "utf8"),
  ).toBe("planned content");
  sdk.afterUpload = undefined;
  expect((await synchronize(sdk, root, config)).results[0]?.status).toBe(
    "review",
  );
  const other = fixture();
  const colliding = new TransferSdk();
  writeFileSync(join(other.local, "file"), "local");
  colliding.beforeUpload = () =>
    colliding.put("external", "root", "file", "external");
  const collision = await synchronize(colliding, root, other);
  expect(collision.summary.failed).toBe(1);
  expect(colliding.history.get("external")).toHaveLength(1);
});

test("lost upload completion is acknowledged only after equality is verified on restart", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  writeFileSync(join(config.local, "file"), "content");
  sdk.afterUpload = () => {
    throw new Error("Simulated lost completion response");
  };
  expect((await synchronize(sdk, root, config)).summary.failed).toBe(1);
  sdk.afterUpload = undefined;
  const dryRun = await prepareReconciliation(sdk, root, config);
  try {
    expect(dryRun.pending).toHaveLength(1);
    expect(dryRun.store.agreements().has("file")).toBe(false);
  } finally {
    dryRun.store.close();
  }
  const mutations = sdk.mutations;
  const recovered = await synchronize(sdk, root, config);
  expect(recovered.summary.recovered).toBe(1);
  expect(recovered.pending).toEqual([]);
  expect(sdk.mutations).toBe(mutations);
});

test("definitely unchanged failed operations can be retried without advancing the baseline", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  writeFileSync(join(config.local, "file"), "content");
  sdk.failures.add("file");
  expect((await synchronize(sdk, root, config)).summary.failed).toBe(1);
  sdk.failures.clear();
  expect((await synchronize(sdk, root, config)).summary.completed).toBe(1);
});

test("concurrent remote revisions are reported and retained rather than falsely acknowledged", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  sdk.put("f", "root", "file", "base");
  writeFileSync(join(config.local, "file"), "base");
  await reconcile(sdk, root, config);
  writeFileSync(join(config.local, "file"), "local");
  sdk.beforeUpload = () => {
    sdk.put("f", "root", "file", "concurrent remote");
  };
  const result = await synchronize(sdk, root, config);
  expect(result.summary.failed).toBe(1);
  expect(result.results[0]?.reason).toContain("Concurrent");
  expect(sdk.history.get("f")).toHaveLength(3);
  expect(result.pending).toHaveLength(1);
});

test("a parent replaced with a symlink during transfer cannot redirect local writes", async () => {
  const config = fixture();
  const sdk = new TransferSdk();
  sdk.nodes.set("folder", node("folder", "root", "folder"));
  sdk.put("f", "folder", "file", "remote");
  mkdirSync(join(config.local, "folder"));
  const outside = join(config.directory, "outside");
  mkdirSync(outside);
  sdk.afterDownload = () => {
    sdk.afterDownload = undefined;
    renameSync(
      join(config.local, "folder"),
      join(config.directory, "old-folder"),
    );
    symlinkSync(outside, join(config.local, "folder"));
  };
  const result = await synchronize(sdk, root, config);
  expect(result.summary.failed).toBe(1);
  expect(readdirSync(outside)).toEqual([]);
});
