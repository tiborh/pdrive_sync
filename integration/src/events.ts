import type { DriveEvent } from "@protontech/drive-sdk";
import { type EventStore, IntegrationBlockedError } from "./store.ts";

export async function readBatch(
  store: EventStore,
  events: AsyncIterable<DriveEvent>,
  onEvent: (event: DriveEvent) => void,
): Promise<number> {
  if (store.blocked) {
    throw new IntegrationBlockedError(
      `Integration remains blocked: ${store.blocked}`,
    );
  }
  let cursor = store.cursor;
  let count = 0;
  for await (const event of events) {
    if (event.treeEventScopeId !== store.scope) {
      throw new Error("SDK returned an event for an unexpected scope.");
    }
    if (store.record(event)) {
      onEvent(event);
      count++;
    }
    cursor = event.eventId;
  }
  // Multiple events can share one cursor. Acknowledge only a completed batch.
  if (cursor !== undefined) {
    store.checkpoint(cursor);
  }
  return count;
}
