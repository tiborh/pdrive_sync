import { expect, test } from "bun:test";
import { makePlan } from "../src/plan.ts";
import {
  fingerprint,
  type Agreement,
  type Entry,
  type RemoteNode,
} from "../src/metadata.ts";

const file = (sha1: string): Entry => ({ kind: "file", size: 3, sha1 });
const node = (entry: Entry, uid = "file"): RemoteNode => ({
  ...entry,
  uid,
  parentUid: "root",
  name: uid,
  verification: entry.kind === "file" ? "sdk" : undefined,
});
const baseline = new Map<string, Agreement>([
  ["a", { fingerprint: "file:3:old", remoteUid: "file" }],
]);

test("three-way content comparison distinguishes one-sided changes and conflicts", () => {
  for (const [left, right, base, expected] of [
    ["same", "same", undefined, "unchanged"],
    ["new", "old", baseline, "upload"],
    ["old", "new", baseline, "download"],
    ["new-local", "new-remote", baseline, "conflict"],
    ["new", "different", undefined, "conflict"],
  ] as const) {
    const plan = makePlan(
      new Map([["a", file(left)]]),
      new Map([["a", node(file(right))]]),
      base ?? new Map(),
    );
    expect(plan.items[0]?.action).toBe(expected);
    expect(plan.agreements.size).toBe(expected === "unchanged" ? 1 : 0);
  }
});

test("proposals never acknowledge transfers and missing agreed files never become new transfers", () => {
  const local = new Map([["a", file("new")]]);
  const remote = new Map([["a", node(file("old"))]]);
  const first = makePlan(local, remote, baseline);
  expect(first.items[0]?.action).toBe("upload");
  expect(first.agreements.size).toBe(0);
  expect(
    makePlan(local, new Map([["a", node(file("other"))]]), baseline).items[0]
      ?.action,
  ).toBe("conflict");
  expect(makePlan(new Map(), remote, baseline).items[0]?.action).toBe("review");
  expect(makePlan(local, new Map(), baseline).items[0]?.action).toBe("review");
  expect(makePlan(new Map(), new Map(), baseline).items[0]?.action).toBe(
    "review",
  );
});

test("new trees include directories and files but type conflicts/unsupported parents suppress descendants", () => {
  const local = new Map<string, Entry>([
    ["upload", { kind: "directory" }],
    ["upload/file", file("local")],
    ["collision", file("local")],
    ["link", { kind: "unsupported", issue: "symlink" }],
  ]);
  const remote = new Map([
    ["download", node({ kind: "directory" }, "d")],
    ["download/empty", node(file("empty"), "e")],
    ["collision", node({ kind: "directory" }, "c")],
    ["collision/child", node(file("remote"), "cc")],
    ["link/child", node(file("remote"), "lc")],
  ]);
  expect(
    makePlan(local, remote, new Map()).items.map(({ path, action }) => [
      path,
      action,
    ]),
  ).toEqual([
    ["collision", "conflict"],
    ["download", "create-local-directory"],
    ["download/empty", "download"],
    ["link", "unsupported"],
    ["upload", "create-remote-directory"],
    ["upload/file", "upload"],
  ]);
});

test("stable identity moves and replaced identities are not mistaken for safe content updates", () => {
  expect(
    makePlan(
      new Map([["a", file("old")]]),
      new Map([["a", node(file("new"), "replacement")]]),
      baseline,
    ).items[0]?.action,
  ).toBe("conflict");
  const moved = makePlan(
    new Map([["a", file("old")]]),
    new Map([["b", node(file("old"))]]),
    baseline,
  );
  expect(moved.items.map((item) => item.action)).toEqual(["review", "review"]);
  expect(fingerprint({ kind: "file" })).toBeUndefined();
});
