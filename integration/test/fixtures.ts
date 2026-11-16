import { createHash } from "node:crypto";
import {
  DriveEventType,
  MemberRole,
  NodeType,
  RevisionState,
  type DriveEvent,
  type NodeEntity,
  type NodeOrUid,
  type FileDownloader,
} from "@protontech/drive-sdk";
import type { MetadataClient } from "../src/remote.ts";

export const sha1 = (text: string) =>
  createHash("sha1").update(text).digest("hex");
export function node(
  uid: string,
  parentUid: string,
  name: string,
  content?: string,
): NodeEntity {
  return {
    uid,
    parentUid,
    name: { ok: true, value: name },
    type: content === undefined ? NodeType.Folder : NodeType.File,
    treeEventScopeId: "scope",
    keyAuthor: { ok: true, value: null },
    nameAuthor: { ok: true, value: null },
    directRole: MemberRole.Inherited,
    ownedBy: {},
    isShared: false,
    isSharedByUrl: false,
    creationTime: new Date(0),
    modificationTime: new Date(0),
    activeRevision:
      content === undefined
        ? undefined
        : {
            uid: `${uid}-${content}`,
            state: RevisionState.Active,
            creationTime: new Date(0),
            contentAuthor: { ok: true, value: null },
            storageSize: 0,
            isImported: false,
            claimedSize: Buffer.byteLength(content),
            claimedDigests: { sha1: sha1(content), sha1Verified: true },
          },
  };
}
export const root = node("root", "account", "test");
export function changed(
  uid: string,
  parentNodeUid = "root",
  eventId = "next",
): Extract<DriveEvent, { isTrashed: boolean }> {
  return {
    type: DriveEventType.NodeUpdated,
    treeEventScopeId: "scope",
    eventId,
    nodeUid: uid,
    parentNodeUid,
    isTrashed: false,
    isShared: false,
  };
}

export class FakeSdk implements MetadataClient {
  nodes = new Map<string, NodeEntity>([["root", root]]);
  events: DriveEvent[] = [];
  listed: string[] = [];
  failBatch = false;
  failVerification = false;
  revisionBytes = new Map<string, Uint8Array>();
  downloaded: string[] = [];
  async getFileRevisionDownloader(revision: string): Promise<FileDownloader> {
    this.downloaded.push(revision);
    const bytes = this.revisionBytes.get(revision);
    if (!bytes) throw new Error("Missing synthetic revision bytes");
    return {
      getClaimedSizeInBytes: () => bytes.length,
      downloadToStream: (stream) => ({
        pause() {},
        resume() {},
        completion: async () => {
          const writer = stream.getWriter();
          try {
            await writer.write(bytes);
            await writer.close();
            if (this.failVerification)
              throw new Error("Synthetic signature failure");
          } finally {
            writer.releaseLock();
          }
        },
        isDownloadCompleteWithSignatureIssues: () => this.failVerification,
      }),
      unsafeDownloadToStream() {
        throw new Error("Unsafe download must not be used");
      },
      getSeekableStream() {
        throw new Error("Unverified stream must not be used");
      },
    };
  }
  async getNode(value: NodeOrUid): Promise<NodeEntity> {
    const uid = typeof value === "string" ? value : value.uid;
    const result = this.nodes.get(uid);
    if (!result) throw new Error(`Missing synthetic node: ${uid}`);
    return result;
  }
  async *iterateFolderChildren(value: NodeOrUid): AsyncGenerator<NodeEntity> {
    const uid = typeof value === "string" ? value : value.uid;
    this.listed.push(uid);
    for (const child of this.nodes.values())
      if (child.parentUid === uid) yield child;
  }
  async *iterateEvents(
    _scope: string,
    cursor?: string,
  ): AsyncGenerator<DriveEvent> {
    if (!cursor)
      yield {
        type: DriveEventType.FastForward,
        treeEventScopeId: "scope",
        eventId: "initial",
      };
    else {
      yield* this.events;
      if (this.failBatch) throw new Error("Interrupted event batch");
    }
  }
}
