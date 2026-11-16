import {
  DriveEventType,
  NodeType,
  type DriveEvent,
  type NodeEntity,
  type ProtonDriveClient,
} from "@protontech/drive-sdk";
import { readRevision } from "./content.ts";
import { remoteMetadata, remotePaths, type RemoteNode } from "./metadata.ts";
import type { ReconcileStore } from "./reconcile-store.ts";

export type MetadataClient = Pick<
  ProtonDriveClient,
  | "getNode"
  | "iterateFolderChildren"
  | "iterateEvents"
  | "getFileRevisionDownloader"
>;

export async function refreshRemote(
  sdk: MetadataClient,
  root: NodeEntity,
  store: ReconcileStore,
): Promise<{
  nodes: Map<string, RemoteNode>;
  cursor: string;
  mode: "bootstrap" | "events";
  events: number;
  listedFolders: number;
  verifiedFiles: number;
  verifiedBytes: number;
}> {
  if (store.blocked)
    throw new Error(`Reconciliation remains blocked: ${store.blocked}`);
  const scope = root.treeEventScopeId;
  const validateRoot = (node: NodeEntity) => {
    if (
      node.uid !== root.uid ||
      node.type !== NodeType.Folder ||
      !node.parentUid ||
      node.trashTime ||
      !node.name.ok ||
      node.errors?.length ||
      node.treeEventScopeId !== scope
    ) {
      store.block(
        "Selected root is missing, trashed, degraded, or no longer a folder",
      );
    }
  };
  validateRoot(root);
  const checkEvent = (event: DriveEvent) => {
    if (event.treeEventScopeId !== scope)
      throw new Error("Unexpected event scope.");
    if (
      event.type === DriveEventType.TreeRefresh ||
      event.type === DriveEventType.TreeRemove ||
      ("nodeUid" in event &&
        event.nodeUid === root.uid &&
        (event.type === DriveEventType.NodeDeleted || event.isTrashed))
    ) {
      store.block(
        `Remote ${event.type}; automatic rescan/deletion inference is disabled`,
      );
    }
  };
  const cached = store.nodes();
  const nodes = new Map(cached);
  let cursor = store.cursor;
  const mode = cursor ? "events" : "bootstrap";
  let listedFolders = 0;
  const snapshot = async (
    folder: string,
    seen = new Set([folder]),
  ): Promise<void> => {
    listedFolders++;
    for await (const child of sdk.iterateFolderChildren(folder)) {
      if (
        child.parentUid !== folder ||
        child.uid === root.uid ||
        seen.has(child.uid)
      ) {
        throw new Error(
          "Inconsistent or duplicate node in remote folder snapshot.",
        );
      }
      seen.add(child.uid);
      const metadata = remoteMetadata(child, scope);
      nodes.set(child.uid, metadata);
      if (metadata.kind === "directory") await snapshot(child.uid, seen);
    }
  };
  if (!cursor) {
    for await (const event of sdk.iterateEvents(scope)) {
      checkEvent(event);
      cursor = event.eventId;
    }
    if (!cursor)
      throw new Error("SDK did not provide an initial event cursor.");
    await snapshot(root.uid);
  }
  type NodeEvent = Extract<DriveEvent, { nodeUid: string }>;
  const changes = new Map<string, NodeEvent>();
  let events = 0;
  for await (const event of sdk.iterateEvents(scope, cursor)) {
    checkEvent(event);
    cursor = event.eventId;
    events++;
    if ("nodeUid" in event && event.nodeUid !== root.uid)
      changes.set(event.nodeUid, event);
  }
  // Hydrate only after the whole batch has invalidated the SDK metadata cache.
  for (const [uid, event] of changes) {
    if (event.type === DriveEventType.NodeDeleted || event.isTrashed) {
      nodes.delete(uid);
      changes.delete(uid);
    } else if (!event.parentNodeUid && !nodes.has(uid)) {
      throw new Error(
        "Cannot classify a remote event without parent metadata.",
      );
    }
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (const [uid, event] of changes) {
      if (event.type === DriveEventType.NodeDeleted) continue;
      if (
        !nodes.has(uid) &&
        event.parentNodeUid !== root.uid &&
        (!event.parentNodeUid ||
          nodes.get(event.parentNodeUid)?.kind !== "directory")
      )
        continue;
      const node = await sdk.getNode(uid);
      if (node.uid !== uid)
        throw new Error("SDK returned unexpected node identity.");
      const metadata = remoteMetadata(node, scope);
      const wasKnown = nodes.has(uid);
      nodes.set(uid, metadata);
      if (!wasKnown && metadata.kind === "directory") await snapshot(uid);
      changes.delete(uid);
      progress = true;
    }
  }
  const reachable = new Set<string>([root.uid]);
  progress = true;
  while (progress) {
    progress = false;
    for (const node of nodes.values()) {
      if (!reachable.has(node.uid) && reachable.has(node.parentUid)) {
        reachable.add(node.uid);
        progress = true;
      }
    }
  }
  for (const uid of nodes.keys()) if (!reachable.has(uid)) nodes.delete(uid);
  remotePaths(nodes, root.uid);
  validateRoot(await sdk.getNode(root.uid));
  let verifiedFiles = 0;
  let verifiedBytes = 0;
  for (const [uid, node] of nodes) {
    if (node.kind !== "file" || node.verification) continue;
    const previous = cached.get(uid);
    if (
      previous?.kind === "file" &&
      previous.revision === node.revision &&
      previous.verification &&
      previous.sha1 !== undefined &&
      previous.size !== undefined
    ) {
      if (
        (node.sha1 !== undefined && node.sha1 !== previous.sha1) ||
        (node.size !== undefined && node.size !== previous.size)
      ) {
        throw new Error("Remote claims changed without a revision change.");
      }
      nodes.set(uid, {
        ...node,
        sha1: previous.sha1,
        size: previous.size,
        verification: previous.verification,
      });
      continue;
    }
    if (!node.revision)
      throw new Error("Cannot verify a remote file without a revision.");
    const { size, sha1 } = await readRevision(sdk, node.revision);
    if (
      (node.sha1 !== undefined && node.sha1 !== sha1) ||
      (node.size !== undefined && node.size !== size)
    ) {
      throw new Error(
        "Verified remote content disagrees with claimed size/digest; no plan was saved.",
      );
    }
    nodes.set(uid, { ...node, size, sha1, verification: "download" });
    verifiedFiles++;
    verifiedBytes += size;
  }
  return {
    nodes,
    cursor,
    mode,
    events,
    listedFolders,
    verifiedFiles,
    verifiedBytes,
  };
}
