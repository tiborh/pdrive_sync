import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  lstatSync,
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
import { DriveEventType, type DriveEvent } from "@protontech/drive-sdk";
import { remoteMetadata, remotePaths } from "../src/metadata.ts";
import { scanLocal } from "../src/local.ts";
import { reconcile, validatePlanPaths } from "../src/reconcile.ts";
import { ReconcileStore, type RootBinding } from "../src/reconcile-store.ts";
import { EventStore } from "../src/store.ts";
import { sha1, node, root, changed, FakeSdk } from "./fixtures.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pdrive-plan-test-"));
  directories.push(directory);
  const local = join(directory, "local");
  mkdirSync(local);
  return {
    directory,
    local,
    state: join(directory, "state.sqlite"),
    remote: "/my-files/test",
    privateDirectories: [],
  };
}
test("local scan hashes hidden/empty/nested/Unicode files and never follows symlinks", async () => {
  const config = fixture();
  mkdirSync(join(config.local, "nested"));
  mkdirSync(join(config.local, "empty"));
  writeFileSync(join(config.local, ".hidden"), "");
  writeFileSync(join(config.local, "nested/árvíz.txt"), "hello");
  const outside = join(config.directory, "outside");
  writeFileSync(outside, "private outside content");
  symlinkSync(outside, join(config.local, "link"));
  symlinkSync("absent", join(config.local, "broken"));
  const before = lstatSync(join(config.local, ".hidden")).mtimeMs;
  const entries = await scanLocal(config.local);
  expect(entries.get(".hidden")).toEqual({
    kind: "file",
    size: 0,
    sha1: sha1(""),
  });
  expect(entries.get("nested/árvíz.txt")?.sha1).toBe(sha1("hello"));
  expect(entries.get("empty")?.kind).toBe("directory");
  expect(entries.get("link")?.kind).toBe("unsupported");
  expect(entries.get("broken")?.kind).toBe("unsupported");
  expect(readFileSync(outside, "utf8")).toBe("private outside content");
  expect(lstatSync(join(config.local, ".hidden")).mtimeMs).toBe(before);
});

test("metadata adapter rejects degraded/unsafe names and flags native documents or unverified hashes", () => {
  expect(remoteMetadata(node("f", "root", "f", ""), "scope").sha1).toBe(
    sha1(""),
  );
  const file = node("f", "root", "f", "test");
  expect(
    remoteMetadata(
      { ...file, mediaType: "application/vnd.proton.doc" },
      "scope",
    ).kind,
  ).toBe("unsupported");
  expect(
    remoteMetadata({ ...file, activeRevision: undefined }, "scope").kind,
  ).toBe("unsupported");
  for (const name of ["..", ".", "", "a/b", "a\0b"]) {
    expect(() =>
      remoteMetadata({ ...file, name: { ok: true, value: name } }, "scope"),
    ).toThrow("path component");
  }
  expect(() =>
    remoteMetadata(
      { ...file, name: { ok: false, error: new Error("decrypt") } },
      "scope",
    ),
  ).toThrow("decrypt");
  expect(() =>
    remoteMetadata({ ...file, errors: [new Error("attributes")] }, "scope"),
  ).toThrow("metadata");
  expect(() => remoteMetadata(file, "other")).toThrow("scope");
  const duplicate = remoteMetadata(file, "scope");
  expect(() =>
    remotePaths(
      new Map([
        ["a", duplicate],
        ["b", { ...duplicate, uid: "b" }],
      ]),
      "root",
    ),
  ).toThrow("duplicate");
});

test("bootstrap recursively plans and persists agreements; restart uses events without relisting", async () => {
  const config = fixture();
  const sdk = new FakeSdk();
  sdk.nodes.set("folder", node("folder", "root", "nested"));
  sdk.nodes.set("f", node("f", "folder", "same", "initial"));
  mkdirSync(join(config.local, "nested"));
  writeFileSync(join(config.local, "nested/same"), "initial");
  writeFileSync(join(config.local, "local-only"), "local");
  const before = readFileSync(join(config.local, "nested/same"));
  const first = await reconcile(sdk, root, config);
  expect(first.remoteUpdate).toEqual({
    mode: "bootstrap",
    events: 0,
    listedFolders: 2,
    verifiedFiles: 0,
    verifiedBytes: 0,
  });
  expect(first.summary).toEqual({ upload: 1, unchanged: 2 });
  const mtime = lstatSync(join(config.local, "nested/same")).mtimeMs;
  writeFileSync(join(config.local, "nested/same"), "local change");
  expect(
    (await reconcile(sdk, root, config)).items.find(
      (item) => item.path === "nested/same",
    )?.action,
  ).toBe("upload");
  sdk.nodes.set("f", node("f", "folder", "same", "remote change"));
  sdk.events = [changed("f", "folder")];
  const next = await reconcile(sdk, root, config);
  expect(next.remoteUpdate).toEqual({
    mode: "events",
    events: 1,
    listedFolders: 0,
    verifiedFiles: 0,
    verifiedBytes: 0,
  });
  expect(next.items.find((item) => item.path === "nested/same")?.action).toBe(
    "conflict",
  );
  expect(sdk.listed).toEqual(["root", "folder"]);
  expect(before.toString()).toBe("initial");
  expect(
    lstatSync(join(config.local, "nested/same")).mtimeMs,
  ).toBeGreaterThanOrEqual(mtime);
  expect(readdirSync(config.local).sort()).toEqual(["local-only", "nested"]);
  expect(lstatSync(config.state).mode & 0o077).toBe(0);
});

test("event batches retain siblings, ignore unrelated scope members, and snapshot only newly entering subtrees", async () => {
  const config = fixture();
  const sdk = new FakeSdk();
  await reconcile(sdk, root, config);
  sdk.nodes.set("a", node("a", "root", "a", "a"));
  sdk.nodes.set("b", node("b", "root", "b", "b"));
  sdk.nodes.set("new", node("new", "root", "new"));
  sdk.nodes.set("child", node("child", "new", "child", "nested"));
  sdk.events = [
    changed("a"),
    changed("b"),
    changed("child", "new"),
    changed("new"),
    changed("unrelated", "outside"),
  ];
  sdk.failBatch = true;
  await expect(reconcile(sdk, root, config)).rejects.toThrow("Interrupted");
  sdk.failBatch = false;
  const plan = await reconcile(sdk, root, config);
  expect(plan.items.map((item) => item.path)).toEqual([
    "a",
    "b",
    "new",
    "new/child",
  ]);
  expect(plan.remoteUpdate.listedFolders).toBe(1);
  sdk.nodes.set("new", node("new", "root", "renamed"));
  sdk.events = [changed("new", "root", "rename")];
  const renamed = await reconcile(sdk, root, config);
  expect(renamed.items.map((item) => item.path)).toEqual([
    "a",
    "b",
    "renamed",
    "renamed/child",
  ]);
  expect(renamed.remoteUpdate.listedFolders).toBe(0);
  sdk.nodes.set("new", node("new", "outside", "renamed"));
  sdk.nodes.set("child", node("child", "root", "rescued", "nested"));
  sdk.events = [
    changed("child", "root", "out"),
    changed("new", "outside", "out"),
  ];
  expect(
    (await reconcile(sdk, root, config)).items.map((item) => item.path),
  ).toEqual(["a", "b", "rescued"]);
});

test("unverified revisions are streamed once, cached across renames, and failures never commit", async () => {
  const config = fixture();
  const sdk = new FakeSdk();
  function unverified(content: string, name = "file") {
    const file = node("f", "root", name, content);
    if (!file.activeRevision?.claimedDigests)
      throw new Error("Missing test revision");
    file.activeRevision.claimedDigests.sha1Verified = false;
    sdk.nodes.set("f", file);
    sdk.revisionBytes.set(
      file.activeRevision.uid,
      new TextEncoder().encode(content),
    );
    return file.activeRevision.uid;
  }
  const firstRevision = unverified("content");
  writeFileSync(join(config.local, "file"), "content");
  const first = await reconcile(sdk, root, config);
  expect(first.remoteUpdate.verifiedFiles).toBe(1);
  expect(first.remoteUpdate.verifiedBytes).toBe(7);
  expect(first.items[0]?.remote?.verification).toBe("download");
  expect((await reconcile(sdk, root, config)).remoteUpdate.verifiedFiles).toBe(
    0,
  );
  unverified("content", "renamed");
  sdk.events = [changed("f")];
  await reconcile(sdk, root, config);
  expect(sdk.downloaded).toEqual([firstRevision]);
  const newRevision = unverified("new", "renamed");
  sdk.events = [changed("f", "root", "new")];
  sdk.failVerification = true;
  await expect(reconcile(sdk, root, config)).rejects.toThrow("signature");
  sdk.failVerification = false;
  sdk.revisionBytes.set(newRevision, new TextEncoder().encode("bad"));
  await expect(reconcile(sdk, root, config)).rejects.toThrow("disagrees");
  sdk.revisionBytes.set(newRevision, new TextEncoder().encode("new"));
  expect((await reconcile(sdk, root, config)).remoteUpdate.verifiedFiles).toBe(
    1,
  );
  expect((await reconcile(sdk, root, config)).remoteUpdate.verifiedFiles).toBe(
    0,
  );
});

test("refresh, root trash, and missing metadata fail closed without an advanced snapshot", async () => {
  for (const event of [
    {
      type: DriveEventType.TreeRefresh,
      treeEventScopeId: "scope",
      eventId: "expired",
    },
    { ...changed("root"), isTrashed: true },
    {
      type: DriveEventType.TreeRemove,
      treeEventScopeId: "scope",
      eventId: "none",
    },
  ] satisfies DriveEvent[]) {
    const config = fixture();
    const sdk = new FakeSdk();
    await reconcile(sdk, root, config);
    sdk.events = [event];
    await expect(reconcile(sdk, root, config)).rejects.toThrow("blocked");
    sdk.events = [];
    await expect(reconcile(sdk, root, config)).rejects.toThrow(
      "remains blocked",
    );
  }
  const config = fixture();
  const sdk = new FakeSdk();
  await reconcile(sdk, root, config);
  sdk.events = [changed("missing")];
  await expect(reconcile(sdk, root, config)).rejects.toThrow(
    "Missing synthetic",
  );
  sdk.events = [];
  expect((await reconcile(sdk, root, config)).remoteUpdate.mode).toBe("events");
});

test("missing agreed files remain review items and failures do not save partial baselines", async () => {
  const config = fixture();
  const sdk = new FakeSdk();
  sdk.nodes.set("f", node("f", "root", "same", "same"));
  writeFileSync(join(config.local, "same"), "same");
  await reconcile(sdk, root, config);
  rmSync(join(config.local, "same"));
  expect((await reconcile(sdk, root, config)).items[0]?.action).toBe("review");
  expect((await reconcile(sdk, root, config)).items[0]?.action).toBe("review");
  sdk.nodes.delete("f");
  sdk.events = [
    {
      type: DriveEventType.NodeDeleted,
      treeEventScopeId: "scope",
      eventId: "deleted",
      nodeUid: "f",
    },
  ];
  expect((await reconcile(sdk, root, config)).items[0]?.action).toBe("review");
});

test("incomplete local scans do not save a remote cursor or a matching baseline", async () => {
  const config = fixture();
  const sdk = new FakeSdk();
  sdk.nodes.set("f", node("f", "root", "file", "same"));
  writeFileSync(join(config.local, "file"), "same");
  const invalidName = Buffer.concat([
    Buffer.from(`${config.local}/`),
    Buffer.from([0xff]),
  ]);
  writeFileSync(invalidName, "unsupported name");
  await expect(reconcile(sdk, root, config)).rejects.toThrow("UTF-8");
  rmSync(invalidName);
  writeFileSync(join(config.local, "file"), "different");
  const plan = await reconcile(sdk, root, config);
  expect(plan.remoteUpdate.mode).toBe("bootstrap");
  expect(plan.items[0]?.action).toBe("conflict");
});

test("a replacement local root cannot silently reuse the old baseline", async () => {
  const config = fixture();
  const sdk = new FakeSdk();
  await reconcile(sdk, root, config);
  renameSync(config.local, join(config.directory, "old-local"));
  mkdirSync(config.local);
  await expect(reconcile(sdk, root, config)).rejects.toThrow(
    "local directory identity",
  );
});

test("root/state preflight rejects missing roots, symlink destinations, overlap and cross-root state reuse", async () => {
  const config = fixture();
  const sdk = new FakeSdk();
  await expect(
    reconcile(sdk, root, {
      ...config,
      state: join(config.local, "state.sqlite"),
    }),
  ).rejects.toThrow("outside");
  expect(readdirSync(config.local)).toEqual([]);
  await expect(
    validatePlanPaths({ ...config, local: join(config.directory, "missing") }),
  ).rejects.toThrow();
  await expect(
    validatePlanPaths({
      ...config,
      privateDirectories: [join(config.local, "cache")],
    }),
  ).rejects.toThrow("overlaps");
  const alias = join(config.directory, "alias");
  symlinkSync(config.local, alias);
  await expect(
    validatePlanPaths({ ...config, state: join(alias, "state.sqlite") }),
  ).rejects.toThrow("outside");
  const stateLink = join(config.directory, "state-link");
  symlinkSync(config.directory, stateLink);
  await expect(
    reconcile(sdk, root, {
      ...config,
      state: join(stateLink, "unsafe.sqlite"),
    }),
  ).rejects.toThrow("symlinks");
  await reconcile(sdk, root, config);
  await expect(
    reconcile(sdk, root, { ...config, remote: "/my-files/other" }),
  ).rejects.toThrow("different roots");
});

test("state schemas, hardlinks, file privacy and exclusive locking are guarded", () => {
  const config = fixture();
  const binding: RootBinding = {
    local: config.local,
    localIdentity: "test",
    remote: config.remote,
    rootUid: "root",
    scope: "scope",
  };
  const store = new ReconcileStore(config.state, binding);
  try {
    expect(() => new ReconcileStore(config.state, binding)).toThrow();
  } finally {
    store.close();
  }
  expect(() => new EventStore(config.state, "scope", "root")).toThrow(
    "event-journal",
  );
  const eventFile = join(config.directory, "events.sqlite");
  new EventStore(eventFile, "scope", "root").close();
  expect(() => new ReconcileStore(eventFile, binding)).toThrow("schema");
  chmodSync(config.state, 0o644);
  expect(() => new ReconcileStore(config.state, binding)).toThrow("private");
  chmodSync(config.state, 0o600);
  linkSync(config.state, join(config.directory, "hardlink"));
  expect(() => new ReconcileStore(config.state, binding)).toThrow("private");
});
