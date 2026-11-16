import { basename, dirname, join, resolve } from "node:path";
import { mkdir, open } from "node:fs/promises";
import {
  RevisionState,
  type NodeEntity,
  type ProtonDriveClient,
  type Revision,
} from "@protontech/drive-sdk";
import {
  LocalAccess,
  errorMessage,
  operationDirectory,
  saveIntent,
} from "./apply-local.ts";
import { readRevision } from "./content.ts";
import { inspectLocal } from "./local.ts";
import {
  fingerprint,
  remoteMetadata,
  remotePaths,
  type Entry,
  type RemoteNode,
} from "./metadata.ts";
import {
  prepareReconciliation,
  validatePlanPaths,
  type PlanConfig,
} from "./reconcile.ts";
import type { TransferIntent } from "./reconcile-store.ts";
import { refreshRemote, type MetadataClient } from "./remote.ts";

export type TransferClient = MetadataClient &
  Pick<
    ProtonDriveClient,
    | "createFolder"
    | "getFileUploader"
    | "getFileRevisionUploader"
    | "iterateRevisions"
  >;
export type SyncItem = {
  path: string;
  action: string;
  status:
    "completed" | "unchanged" | "skipped" | "failed" | "review" | "recovered";
  reason: string;
  recovery?: string;
};

function localKey(entry: Entry | undefined): string | null {
  return entry ? (fingerprint(entry) ?? `unsupported:${entry.issue}`) : null;
}
function remoteKey(entry: RemoteNode | undefined): string | null {
  return entry
    ? JSON.stringify([
        entry.uid,
        entry.parentUid,
        entry.revision,
        localKey(entry),
      ])
    : null;
}

export async function validateSyncPaths(config: PlanConfig): Promise<void> {
  await validatePlanPaths(config);
  await validatePlanPaths({
    ...config,
    state: join(`${resolve(config.state)}.files`, "operation"),
    privateDirectories: [
      ...config.privateDirectories,
      `${resolve(config.state)}.files`,
    ],
  });
}

async function revisions(
  sdk: TransferClient,
  node: RemoteNode,
): Promise<Revision[]> {
  const result: Revision[] = [];
  for await (const revision of sdk.iterateRevisions(node.uid))
    result.push(revision);
  if (
    result.filter((revision) => revision.state === RevisionState.Active)
      .length !== 1 ||
    !result.some(
      (revision) =>
        revision.uid === node.revision &&
        revision.state === RevisionState.Active,
    )
  ) {
    throw new Error("Remote active revision changed since planning.");
  }
  return result;
}

export async function synchronize(
  sdk: TransferClient,
  root: NodeEntity,
  config: PlanConfig,
) {
  await validateSyncPaths(config);
  const context = await prepareReconciliation(sdk, root, config);
  const { store, local, plan } = context;
  let access: LocalAccess | undefined;
  const results: SyncItem[] = [];
  const blocked: string[] = [];
  const handled = new Set<string>();
  const parentIds = new Map(
    [...remotePaths(context.refreshed.nodes, root.uid)]
      .filter(([, node]) => node.kind === "directory")
      .map(([path, node]) => [path, node.uid]),
  );
  parentIds.set("", root.uid);
  const refresh = async () => {
    const current = await refreshRemote(sdk, root, store);
    store.commit(current.nodes, current.cursor, new Map());
    return remotePaths(current.nodes, root.uid);
  };
  try {
    access = await LocalAccess.create(local.path, local.identity);
    const currentPaths = remotePaths(context.refreshed.nodes, root.uid);
    for (const pending of context.pending) {
      const left = await access.inspect(pending.path);
      const right = currentPaths.get(pending.path);
      if (
        right &&
        localKey(left) === pending.target &&
        localKey(right) === pending.target &&
        (!pending.remoteUid || right.uid === pending.remoteUid)
      ) {
        store.complete(pending.path, right);
        results.push({
          path: pending.path,
          action: pending.action,
          status: "recovered",
          reason:
            "An interrupted transfer is now verified equal on both sides.",
          recovery: pending.artifact,
        });
        handled.add(pending.path);
      } else if (
        localKey(left) === pending.beforeLocal &&
        remoteKey(right) === pending.beforeRemote
      ) {
        store.retry(pending.path);
      } else {
        results.push({
          path: pending.path,
          action: pending.action,
          status: "review",
          reason:
            "Interrupted transfer has ambiguous results; restore/reconcile using the retained recovery files before retrying.",
          recovery: pending.artifact,
        });
        blocked.push(pending.path);
        handled.add(pending.path);
      }
    }
    for (const item of plan.items) {
      if (handled.has(item.path)) continue;
      if (
        blocked.some(
          (path) => item.path === path || item.path.startsWith(`${path}/`),
        )
      ) {
        results.push({
          path: item.path,
          action: item.action,
          status: "skipped",
          reason: "A parent or this path has an unresolved transfer.",
        });
        continue;
      }
      if (["conflict", "review", "unsupported"].includes(item.action)) {
        results.push({
          path: item.path,
          action: item.action,
          status: "skipped",
          reason: item.reason,
        });
        blocked.push(item.path);
        continue;
      }
      if (item.action === "unchanged") {
        results.push({
          path: item.path,
          action: item.action,
          status: "unchanged",
          reason: item.reason,
        });
        continue;
      }
      let artifact: string | undefined;
      try {
        let paths = await refresh();
        const right = paths.get(item.path);
        const left = await access.inspect(item.path);
        if (
          localKey(left) !== localKey(item.local) ||
          remoteKey(right) !== remoteKey(item.remote)
        ) {
          throw new Error(
            "Inputs changed since this run's plan; no transfer was applied.",
          );
        }
        const parentPath = dirname(item.path) === "." ? "" : dirname(item.path);
        const parentUid = parentPath ? paths.get(parentPath)?.uid : root.uid;
        if (!parentUid || parentUid !== parentIds.get(parentPath)) {
          throw new Error("Remote parent changed or could not be created.");
        }
        artifact = await operationDirectory(config.state);
        const target = ["upload", "create-remote-directory"].includes(
          item.action,
        )
          ? item.local
          : item.remote;
        if (!target || !fingerprint(target))
          throw new Error("Missing verified transfer content.");
        const intent: TransferIntent = {
          path: item.path,
          action: item.action,
          target: fingerprint(target) ?? "",
          beforeLocal: localKey(left),
          beforeRemote: remoteKey(right),
          remoteUid: right?.uid ?? null,
          artifact,
        };
        let completed: RemoteNode;
        if (item.action === "create-local-directory") {
          await saveIntent(intent);
          store.begin(intent);
          const parent = await access.parent(item.path);
          try {
            await parent.assertCurrent();
            await mkdir(parent.path, { mode: 0o700 });
            await parent.handle.sync();
          } finally {
            await parent.close();
          }
          if (!right) throw new Error("Remote directory disappeared.");
          completed = right;
        } else if (item.action === "create-remote-directory") {
          await saveIntent(intent);
          store.begin(intent);
          completed = remoteMetadata(
            await sdk.createFolder(parentUid, basename(item.path)),
            root.treeEventScopeId,
          );
          parentIds.set(item.path, completed.uid);
        } else if (item.action === "upload") {
          if (
            target.kind !== "file" ||
            target.size === undefined ||
            !target.sha1
          )
            throw new Error("Missing upload size/hash.");
          const stage = join(artifact, "incoming");
          const snapshot = await open(stage, "wx", 0o600);
          try {
            const parent = await access.parent(item.path);
            try {
              const copied = await inspectLocal(parent.path, snapshot);
              if (localKey(copied) !== intent.target)
                throw new Error("Upload source changed during staging.");
            } finally {
              await parent.close();
            }
            await snapshot.sync();
          } finally {
            await snapshot.close();
          }
          paths = await refresh();
          if (remoteKey(paths.get(item.path)) !== intent.beforeRemote)
            throw new Error("Remote destination changed during staging.");
          const before = right ? await revisions(sdk, right) : [];
          await saveIntent(intent);
          store.begin(intent);
          const metadata = {
            mediaType: "application/octet-stream",
            expectedSize: target.size,
            expectedSha1: target.sha1,
            overrideExistingDraftByOtherClient: false,
          };
          const uploader = right
            ? await sdk.getFileRevisionUploader(right.uid, metadata)
            : await sdk.getFileUploader(
                parentUid,
                basename(item.path),
                metadata,
              );
          const controller = await uploader.uploadFromStream(
            Bun.file(stage).stream(),
            [],
          );
          const receipt = await controller.completion();
          const updated = await refresh();
          const actual = updated.get(item.path);
          if (
            !actual ||
            actual.uid !== receipt.nodeUid ||
            actual.revision !== receipt.nodeRevisionUid ||
            localKey(actual) !== intent.target
          ) {
            throw new Error(
              "Upload completion does not match the current remote file; recovery snapshot retained.",
            );
          }
          if (right) {
            const after = await revisions(sdk, actual);
            const known = new Set(before.map((revision) => revision.uid));
            if (
              !after.some((revision) => revision.uid === right.revision) ||
              after.some(
                (revision) =>
                  !known.has(revision.uid) &&
                  revision.uid !== receipt.nodeRevisionUid,
              )
            ) {
              throw new Error(
                "Concurrent remote revisions detected; both versions remain in Proton revision history.",
              );
            }
          }
          if (localKey(await access.inspect(item.path)) !== intent.target) {
            throw new Error(
              "Upload source changed before acknowledgement; uploaded snapshot retained.",
            );
          }
          completed = actual;
        } else if (item.action === "download") {
          if (!right?.revision)
            throw new Error("No remote revision to download.");
          const stage = join(artifact, "incoming");
          const snapshot = await open(stage, "wx", 0o600);
          try {
            const downloaded = await readRevision(
              sdk,
              right.revision,
              async (chunk) => {
                await snapshot.writeFile(chunk);
              },
            );
            if (localKey(downloaded) !== intent.target)
              throw new Error(
                "Downloaded content did not match the planned hash/size.",
              );
            await snapshot.sync();
          } finally {
            await snapshot.close();
          }
          paths = await refresh();
          if (remoteKey(paths.get(item.path)) !== intent.beforeRemote)
            throw new Error("Remote source changed during download.");
          await revisions(sdk, right);
          await saveIntent(intent);
          store.begin(intent);
          await access.install(item.path, stage, artifact, left, right);
          completed = right;
        } else {
          throw new Error(`Unsupported apply action: ${item.action}`);
        }
        if (
          localKey(completed) !== intent.target ||
          completed.name !== basename(item.path) ||
          completed.parentUid !== parentUid ||
          localKey(await access.inspect(item.path)) !== intent.target
        ) {
          throw new Error(
            "Transferred path/content changed before acknowledgement.",
          );
        }
        store.complete(item.path, completed);
        results.push({
          path: item.path,
          action: item.action,
          status: "completed",
          reason: "Transfer verified and matching baseline committed.",
          recovery: artifact,
        });
      } catch (error) {
        results.push({
          path: item.path,
          action: item.action,
          status: "failed",
          reason: errorMessage(error),
          recovery: artifact,
        });
        blocked.push(item.path);
      }
    }
    return {
      kind: "sync" as const,
      schemaVersion: 1,
      deletionPropagation: false,
      roots: { local: local.path, remote: config.remote },
      summary: results.reduce<Record<string, number>>((summary, item) => {
        summary[item.status] = (summary[item.status] ?? 0) + 1;
        return summary;
      }, {}),
      results,
      pending: store.pending(),
    };
  } finally {
    await access?.close();
    store.close();
  }
}
