import {
  fingerprint,
  type Agreement,
  type Entry,
  type RemoteNode,
} from "./metadata.ts";

export type PlanItem = {
  path: string;
  action:
    | "unchanged"
    | "upload"
    | "download"
    | "create-local-directory"
    | "create-remote-directory"
    | "conflict"
    | "review"
    | "unsupported";
  reason: string;
  local?: Entry;
  remote?: RemoteNode;
};

export function makePlan(
  local: ReadonlyMap<string, Entry>,
  remote: ReadonlyMap<string, RemoteNode>,
  previous: ReadonlyMap<string, Agreement>,
): { items: PlanItem[]; agreements: Map<string, Agreement> } {
  const paths = [
    ...new Set([...local.keys(), ...remote.keys(), ...previous.keys()]),
  ].sort();
  const blocked: string[] = [];
  const agreements = new Map<string, Agreement>();
  const oldPaths = new Map(
    [...previous].map(([path, value]) => [value.remoteUid, path]),
  );
  const items: PlanItem[] = [];
  for (const path of paths) {
    if (blocked.some((parent) => path.startsWith(`${parent}/`))) continue;
    const left = local.get(path);
    const right = remote.get(path);
    const base = previous.get(path);
    const lfp = left && fingerprint(left);
    const rfp = right && fingerprint(right);
    let action: PlanItem["action"];
    let reason: string;
    if (right?.kind === "file" && !right.verification) {
      action = "unsupported";
      reason = "Remote file content has not been verified.";
    } else if (left?.kind === "unsupported" || right?.kind === "unsupported") {
      action = "unsupported";
      reason = [left?.issue, right?.issue].filter(Boolean).join("; ");
    } else if (!left && !right) {
      action = "review";
      reason =
        "Both previously matching entries are now absent; no deletion is acknowledged.";
    } else if (
      right &&
      oldPaths.has(right.uid) &&
      oldPaths.get(right.uid) !== path
    ) {
      action = "review";
      reason =
        "Stable remote identity changed path; move handling is deferred.";
    } else if (left && right && left.kind !== right.kind) {
      action = "conflict";
      reason = "A file and a directory occupy the same path.";
    } else if (left && right && lfp !== undefined && lfp === rfp) {
      action = "unchanged";
      reason =
        left.kind === "directory"
          ? "Directory exists on both sides."
          : "Size and verified remote SHA-1 match local content.";
      agreements.set(path, { fingerprint: lfp, remoteUid: right.uid });
    } else if (!left || !right) {
      if (base) {
        action = "review";
        reason =
          "A previously matching entry is missing on one side; deletion propagation is disabled.";
      } else if (left) {
        action =
          left.kind === "directory" ? "create-remote-directory" : "upload";
        reason =
          "Local-only entry with no matching baseline; propose a remote copy.";
      } else {
        action =
          right?.kind === "directory" ? "create-local-directory" : "download";
        reason =
          "Remote-only entry with no matching baseline; propose a local copy.";
      }
    } else if (!lfp || !rfp) {
      action = "unsupported";
      reason = "Insufficient content metadata for a safe comparison.";
    } else if (!base || base.remoteUid !== right.uid) {
      action = "conflict";
      reason =
        "Different content with no shared matching baseline, or remote identity was replaced.";
    } else if (lfp === base.fingerprint) {
      action = "download";
      reason =
        "Remote content changed; local content still matches the last agreement.";
    } else if (rfp === base.fingerprint) {
      action = "upload";
      reason =
        "Local content changed; remote content still matches the last agreement.";
    } else {
      action = "conflict";
      reason =
        "Both sides changed since the last matching content; preserve both versions.";
    }
    items.push({ path, action, reason, local: left, remote: right });
    if (["conflict", "review", "unsupported"].includes(action))
      blocked.push(path);
  }
  return { items, agreements };
}
