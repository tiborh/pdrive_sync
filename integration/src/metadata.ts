import { NodeType, type NodeEntity } from "@protontech/drive-sdk";

export type Entry = {
  kind: "file" | "directory" | "unsupported";
  size?: number;
  sha1?: string;
  issue?: string;
};

export type RemoteNode = Entry & {
  uid: string;
  parentUid: string;
  name: string;
  revision?: string;
  verification?: "sdk" | "download";
};

export type Agreement = {
  fingerprint: string;
  remoteUid: string;
};

export function validateName(name: string): void {
  if (!name || name === "." || name === ".." || /[/\0]/u.test(name)) {
    throw new Error("Remote name is not a safe Linux path component.");
  }
}

export function remoteMetadata(node: NodeEntity, scope: string): RemoteNode {
  if (!node.name.ok || node.errors?.length) {
    throw new Error(`Cannot trust/decrypt remote metadata for ${node.uid}.`);
  }
  validateName(node.name.value);
  if (!node.parentUid || node.treeEventScopeId !== scope || node.trashTime) {
    throw new Error(
      `Unexpected remote parent, scope, or trash state: ${node.uid}`,
    );
  }
  const base = {
    uid: node.uid,
    parentUid: node.parentUid,
    name: node.name.value,
  };
  if (node.type === NodeType.Folder) {
    return { ...base, kind: "directory" };
  }
  if (
    node.type !== NodeType.File ||
    ["application/vnd.proton.doc", "application/vnd.proton.sheet"].includes(
      node.mediaType ?? "",
    )
  ) {
    return {
      ...base,
      kind: "unsupported",
      issue: "Unsupported remote file type",
    };
  }
  const revision = node.activeRevision;
  const size = revision?.claimedSize;
  const sha1 = revision?.claimedDigests?.sha1;
  if (!revision) {
    return {
      ...base,
      kind: "unsupported",
      issue: "No downloadable active revision",
    };
  }
  if (
    (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) ||
    (sha1 !== undefined && !/^[a-f\d]{40}$/iu.test(sha1))
  ) {
    throw new Error(`Invalid remote size/content digest: ${node.uid}`);
  }
  return {
    ...base,
    kind: "file",
    size,
    sha1: sha1?.toLowerCase(),
    revision: revision.uid,
    verification:
      sha1 && size !== undefined && revision.claimedDigests?.sha1Verified
        ? "sdk"
        : undefined,
  };
}

export function fingerprint(entry: Entry): string | undefined {
  if (entry.kind === "directory") return "directory";
  if (
    entry.kind === "file" &&
    entry.sha1 !== undefined &&
    entry.size !== undefined
  ) {
    return `file:${entry.size}:${entry.sha1}`;
  }
  return undefined;
}

export function remotePaths(
  nodes: ReadonlyMap<string, RemoteNode>,
  root: string,
): Map<string, RemoteNode> {
  const paths = new Map<string, string>([[root, ""]]);
  const visiting = new Set<string>();
  const pathFor = (uid: string): string => {
    const cached = paths.get(uid);
    if (cached !== undefined) return cached;
    const node = nodes.get(uid);
    if (!node || visiting.has(uid)) {
      throw new Error("Remote snapshot has a missing parent or a cycle.");
    }
    validateName(node.name);
    visiting.add(uid);
    if (
      node.parentUid !== root &&
      nodes.get(node.parentUid)?.kind !== "directory"
    ) {
      throw new Error("Remote snapshot parent is not a directory.");
    }
    const parent = pathFor(node.parentUid);
    const path = parent ? `${parent}/${node.name}` : node.name;
    visiting.delete(uid);
    paths.set(uid, path);
    return path;
  };
  const result = new Map<string, RemoteNode>();
  for (const [uid, node] of nodes) {
    const path = pathFor(uid);
    if (result.has(path)) {
      throw new Error(
        `Ambiguous duplicate remote path: ${JSON.stringify(path)}`,
      );
    }
    result.set(path, node);
  }
  return result;
}
