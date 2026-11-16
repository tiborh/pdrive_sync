import { resolve, dirname, basename } from "node:path";
import { realpath } from "node:fs/promises";
import type { NodeEntity } from "@protontech/drive-sdk";
import { isMissing } from "./database.ts";
import { containsPath, localRoot, scanLocal } from "./local.ts";
import { remotePaths } from "./metadata.ts";
import { makePlan } from "./plan.ts";
import { ReconcileStore } from "./reconcile-store.ts";
import { refreshRemote, type MetadataClient } from "./remote.ts";

export type PlanConfig = {
  local: string;
  remote: string;
  state: string;
  privateDirectories: string[];
};

async function canonicalDestination(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return resolve(
      await canonicalDestination(dirname(absolute)),
      basename(absolute),
    );
  }
}

export async function validatePlanPaths(config: PlanConfig) {
  const local = await localRoot(config.local);
  const state = await canonicalDestination(config.state);
  if (containsPath(local.path, state)) {
    throw new Error(
      "--state must be outside the local root; planning must not write into it.",
    );
  }
  for (const directory of config.privateDirectories) {
    const privatePath = await canonicalDestination(directory);
    if (
      containsPath(local.path, privatePath) ||
      containsPath(privatePath, local.path)
    ) {
      throw new Error(
        "Local root overlaps the helper's private data/cache/log directories.",
      );
    }
  }
  return local;
}

export async function prepareReconciliation(
  sdk: MetadataClient,
  root: NodeEntity,
  config: PlanConfig,
) {
  const local = await validatePlanPaths(config);
  const state = resolve(config.state);
  const store = new ReconcileStore(state, {
    local: local.path,
    localIdentity: local.identity,
    remote: config.remote,
    rootUid: root.uid,
    scope: root.treeEventScopeId,
  });
  try {
    const refreshed = await refreshRemote(sdk, root, store);
    const entries = await scanLocal(local.path);
    if ((await localRoot(local.path)).identity !== local.identity) {
      throw new Error("Local root was replaced while planning.");
    }
    const plan = makePlan(
      entries,
      remotePaths(refreshed.nodes, root.uid),
      store.agreements(),
    );
    const pending = store.pending();
    for (const intent of pending) plan.agreements.delete(intent.path);
    store.commit(refreshed.nodes, refreshed.cursor, plan.agreements);
    return { store, local, refreshed, plan, pending };
  } catch (error) {
    store.close();
    throw error;
  }
}

export async function reconcile(
  sdk: MetadataClient,
  root: NodeEntity,
  config: PlanConfig,
) {
  const { store, local, refreshed, plan, pending } =
    await prepareReconciliation(sdk, root, config);
  try {
    const summary: Record<string, number> = {};
    for (const item of plan.items)
      summary[item.action] = (summary[item.action] ?? 0) + 1;
    return {
      kind: "dry-run" as const,
      schemaVersion: 1,
      readOnly: true,
      roots: { local: local.path, remote: config.remote },
      remoteUpdate: {
        mode: refreshed.mode,
        events: refreshed.events,
        listedFolders: refreshed.listedFolders,
        verifiedFiles: refreshed.verifiedFiles,
        verifiedBytes: refreshed.verifiedBytes,
      },
      summary,
      items: plan.items,
      pending,
    };
  } finally {
    store.close();
  }
}
