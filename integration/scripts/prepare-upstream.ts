import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { UPSTREAM_REVISION } from "../src/identity.ts";

const root = resolve(import.meta.dir, "../..");
const local = resolve(root, ".local");
const upstream = resolve(local, "proton-sdk");
const repository = "https://github.com/ProtonDriveApps/sdk.git";
const patch = resolve(root, "integration/patches/reference-host.patch");

function git(...args: string[]): string {
  return execFileSync("git", ["-C", upstream, ...args], {
    encoding: "utf8",
  }).trim();
}

for (const path of [local, upstream]) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing a symlink at ${path}`);
  }
}
mkdirSync(local, { recursive: true });
if (!existsSync(upstream)) {
  mkdirSync(upstream);
  execFileSync("git", ["init", upstream], { stdio: "inherit" });
  git("remote", "add", "origin", repository);
  git("fetch", "--depth=1", "--filter=blob:none", "origin", UPSTREAM_REVISION);
  git("sparse-checkout", "init", "--cone");
  git(
    "sparse-checkout",
    "set",
    "cli",
    "client/js",
    "incubating/account/js",
    "config/js",
  );
  git("checkout", "--detach", UPSTREAM_REVISION);
}
if (
  git("remote", "get-url", "origin") !== repository ||
  git("rev-parse", "HEAD") !== UPSTREAM_REVISION
) {
  throw new Error(
    "Existing upstream checkout does not match the pinned source.",
  );
}
const alreadyApplied = Bun.spawnSync(
  ["git", "-C", upstream, "apply", "--reverse", "--check", patch],
  { stdout: "pipe", stderr: "pipe" },
).exitCode;
if (alreadyApplied !== 0) {
  git("apply", "--check", patch);
  git("apply", patch);
}
for (const [filename, before, after] of [
  ["cli/src/config.ts", "'proton-drive-cli'", "'pdrive_sync-integration'"],
  [
    "cli/src/credentials/constants.ts",
    "'ch.proton.drive/drive-sdk-cli'",
    "'pdrive_sync/integration-session'",
  ],
]) {
  const expected = git("show", `HEAD:${filename}`).replace(before, after);
  if (readFileSync(resolve(upstream, filename), "utf8").trim() !== expected) {
    throw new Error(`Unexpected reference host changes in ${filename}`);
  }
}
const lockfile = resolve(upstream, "cli/bun.lock");
const originalLock = git("show", "HEAD:cli/bun.lock");
const mirroredLock = originalLock.replaceAll(
  "https://pkg.protontech.ch/npm/npm-public/",
  "https://registry.npmjs.org/",
);
if (
  readFileSync(lockfile, "utf8").trim() !== originalLock.trim() &&
  readFileSync(lockfile, "utf8").trim() !== mirroredLock.trim()
) {
  throw new Error("Unexpected changes to the upstream dependency lockfile.");
}
writeFileSync(lockfile, `${mirroredLock}\n`);
const changes = git("diff", "--name-only").split("\n").filter(Boolean).sort();
if (
  JSON.stringify(changes) !==
  JSON.stringify([
    "cli/bun.lock",
    "cli/src/config.ts",
    "cli/src/credentials/constants.ts",
  ])
) {
  throw new Error("Unexpected changes in the reference host checkout.");
}
execFileSync(
  process.execPath,
  ["install", "--frozen-lockfile", "--ignore-scripts"],
  { cwd: resolve(upstream, "cli"), stdio: "inherit" },
);
const sharedModules = resolve(upstream, "node_modules");
if (existsSync(sharedModules)) {
  if (
    !lstatSync(sharedModules).isSymbolicLink() ||
    readlinkSync(sharedModules) !== "cli/node_modules"
  ) {
    throw new Error("Unexpected shared dependency directory in the checkout.");
  }
} else {
  symlinkSync("cli/node_modules", sharedModules);
}
console.log(`Prepared attributed reference host at ${UPSTREAM_REVISION}.`);
