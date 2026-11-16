import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveEventType, type DriveEvent } from "@protontech/drive-sdk";
import { EventStore } from "../src/store.ts";
import { readBatch } from "../src/events.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pdrive-event-test-"));
  directories.push(directory);
  const filename = join(directory, "events.sqlite");
  return { filename, store: new EventStore(filename, "scope", "root") };
}
function created(
  uid: string,
  eventId = "next",
): Extract<DriveEvent, { isTrashed: boolean }> {
  return {
    type: DriveEventType.NodeCreated,
    treeEventScopeId: "scope",
    eventId,
    nodeUid: uid,
    parentNodeUid: "root",
    isTrashed: false,
    isShared: false,
  };
}
async function* sequence(events: DriveEvent[]) {
  yield* events;
}
test("restart replays all siblings sharing a cursor after partial failure", async () => {
  const { filename, store } = fixture();
  store.checkpoint("previous");
  async function* interrupted() {
    yield created("a");
    throw new Error("connection interrupted");
  }
  await expect(readBatch(store, interrupted(), () => {})).rejects.toThrow(
    "interrupted",
  );
  expect(store.cursor).toBe("previous");
  store.close();
  const reopened = new EventStore(filename, "scope", "root");
  try {
    expect(
      await readBatch(
        reopened,
        sequence([created("a"), created("b")]),
        () => {},
      ),
    ).toBe(1);
    expect(reopened.eventCount).toBe(2);
    expect(reopened.cursor).toBe("next");
  } finally {
    reopened.close();
  }
});
test("refresh blocks advancement and remains blocked after restart", async () => {
  const { filename, store } = fixture();
  store.checkpoint("previous");
  await expect(
    readBatch(
      store,
      sequence([
        created("a"),
        {
          type: DriveEventType.TreeRefresh,
          treeEventScopeId: "scope",
          eventId: "refresh",
        },
      ]),
      () => {},
    ),
  ).rejects.toThrow("snapshot");
  expect(store.cursor).toBe("previous");
  store.close();
  const reopened = new EventStore(filename, "scope", "root");
  try {
    await expect(readBatch(reopened, sequence([]), () => {})).rejects.toThrow(
      "blocked",
    );
  } finally {
    reopened.close();
  }
});
test("filters unrelated events but records moves of known direct children", async () => {
  const { store } = fixture();
  try {
    store.seed(["known"]);
    await readBatch(
      store,
      sequence([
        { ...created("unrelated"), parentNodeUid: "other" },
        {
          ...created("known"),
          type: DriveEventType.NodeUpdated,
          parentNodeUid: "other",
        },
      ]),
      () => {},
    );
    expect(store.eventCount).toBe(1);
    expect(store.cursor).toBe("next");
    await readBatch(
      store,
      sequence([
        {
          ...created("known", "outside"),
          type: DriveEventType.NodeUpdated,
          parentNodeUid: "other",
        },
      ]),
      () => {},
    );
    expect(store.eventCount).toBe(1);
  } finally {
    store.close();
  }
});
test("state cannot be reused for a different folder or concurrently opened", () => {
  const { filename, store } = fixture();
  try {
    expect(() => new EventStore(filename, "scope", "root")).toThrow();
  } finally {
    store.close();
  }
  expect(() => new EventStore(filename, "scope", "different")).toThrow(
    "different",
  );
});
test("unexpected event scope cannot advance the checkpoint", async () => {
  const { store } = fixture();
  try {
    store.checkpoint("previous");
    await expect(
      readBatch(
        store,
        sequence([{ ...created("a"), treeEventScopeId: "wrong" }]),
        () => {},
      ),
    ).rejects.toThrow("scope");
    expect(store.cursor).toBe("previous");
  } finally {
    store.close();
  }
});
test("volume removal and root deletion preserve the last checkpoint", async () => {
  for (const event of [
    {
      type: DriveEventType.TreeRemove,
      treeEventScopeId: "scope",
      eventId: "none",
    },
    {
      type: DriveEventType.NodeDeleted,
      treeEventScopeId: "scope",
      eventId: "deleted",
      nodeUid: "root",
    },
  ] satisfies DriveEvent[]) {
    const { store } = fixture();
    try {
      store.checkpoint("previous");
      await expect(
        readBatch(store, sequence([event]), () => {}),
      ).rejects.toThrow("recovery");
      expect(store.cursor).toBe("previous");
    } finally {
      store.close();
    }
  }
});
