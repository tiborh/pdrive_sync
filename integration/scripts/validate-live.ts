import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { APP_VERSION, SDK_VERSION } from "../src/identity.ts";
import { scanLocal } from "../src/local.ts";
import type { reconcile } from "../src/reconcile.ts";

if (process.env.PDRIVE_ALLOW_LIVE_TESTS !== "1") {
  throw new Error("Live validation is opt-in: set PDRIVE_ALLOW_LIVE_TESTS=1.");
}
const { values } = parseArgs({
  options: { "planning-only": { type: "boolean" } },
});
process.umask(0o077);
const integration = resolve(import.meta.dir, "..");
const helper = resolve(integration, "dist/pdrive-integration");
const executable = Bun.which("proton-drive");
if (!executable) {
  throw new Error("The authenticated official proton-drive CLI is required.");
}
const official = executable;
const tag = `pdrive-sync-integration-${randomUUID().slice(0, 12)}`;
const local = resolve(integration, "../.local/validation", tag);
const remote = `/my-files/${tag}`;
const state = resolve(local, "events.sqlite");
const file = resolve(local, `${tag}.txt`);
mkdirSync(local, { recursive: true, mode: 0o700 });
const report: {
  appVersion: string;
  sdkVersion: string;
  checks: { name: string; passed: boolean }[];
  cleanup: string;
  error?: string;
} = {
  appVersion: APP_VERSION,
  sdkVersion: SDK_VERSION,
  checks: [],
  cleanup: "not created",
};
function save(): void {
  writeFileSync(
    resolve(local, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
}
function check(name: string, passed: boolean): void {
  report.checks.push({ name, passed });
  save();
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  if (!passed) throw new Error(`Validation failed: ${name}`);
}
async function command(
  executable: string,
  args: string[],
  allowedExitCodes = [0],
): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!allowedExitCodes.includes(code))
    throw new Error(`${args.slice(0, 2).join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}
async function cloud(...args: string[]): Promise<string> {
  return command(official, [...args, "--json"]);
}
type Output = {
  kind?: string;
  cursor?: string;
  authenticated?: boolean;
  nodeUid?: string;
  event?: { type: string; nodeUid?: string; isTrashed?: boolean };
};
function records(text: string): Output[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
async function once(): Promise<Output[]> {
  return records(
    await command(helper, [
      "events",
      "--remote",
      remote,
      "--state",
      state,
      "--once",
    ]),
  );
}
function watch(seconds: number) {
  const child = Bun.spawn(
    [
      helper,
      "events",
      "--remote",
      remote,
      "--state",
      state,
      "--watch",
      "--seconds",
      String(seconds),
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const ready = Promise.withResolvers<void>();
  const result: Output[] = [];
  const timeout = setTimeout(() => {
    ready.reject(new Error("Watcher did not checkpoint within 20 seconds."));
  }, 20_000);
  const consume = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const row: Output = JSON.parse(line);
        result.push(row);
        if (
          result.some((item) => item.kind === "watching") &&
          result.some((item) => item.kind === "checkpoint")
        ) {
          ready.resolve();
          clearTimeout(timeout);
        }
      }
    }
  })();
  const stderr = new Response(child.stderr).text();
  return { child, ready: ready.promise, result, consume, stderr, timeout };
}
async function trashFixture(): Promise<string> {
  await cloud("filesystem", "trash", remote);
  const trash: { name: { value: string } } = JSON.parse(
    await cloud("filesystem", "info", `/trash/${tag}`),
  );
  if (trash.name.value !== tag) {
    throw new Error("Disposable folder not identified in trash.");
  }
  return "synthetic folder verified in trash; no permanent deletion";
}

async function validatePlanning(): Promise<void> {
  const planningRoot = `${remote}/reconciliation`;
  const planningLocal = resolve(local, "reconciliation");
  const seedDirectory = resolve(local, "remote-seeds");
  const planningState = resolve(local, "reconciliation.sqlite");
  mkdirSync(resolve(planningLocal, "nested"), { recursive: true, mode: 0o700 });
  mkdirSync(seedDirectory, { mode: 0o700 });
  await cloud("filesystem", "create-folder", remote, "reconciliation");
  await cloud("filesystem", "create-folder", planningRoot, "nested");
  async function upload(name: string, contents: string, parent = planningRoot) {
    const seed = resolve(seedDirectory, name);
    writeFileSync(seed, contents);
    await cloud(
      "filesystem",
      "upload",
      seed,
      parent,
      "--file-conflict-strategy",
      "create-new-revision",
      "--skip-thumbnails",
    );
  }
  writeFileSync(resolve(planningLocal, "same.txt"), "same\n");
  writeFileSync(resolve(planningLocal, "local-only.txt"), "local only\n");
  writeFileSync(resolve(planningLocal, "conflict.txt"), "local conflict\n");
  writeFileSync(resolve(planningLocal, "nested/empty.txt"), "");
  await upload("same.txt", "same\n");
  await upload("remote-only.txt", "remote only\n");
  await upload("conflict.txt", "remote conflict\n");
  await upload("empty.txt", "", `${planningRoot}/nested`);
  type Plan = Awaited<ReturnType<typeof reconcile>>;
  const args = [
    "plan",
    "--local",
    planningLocal,
    "--remote",
    planningRoot,
    "--state",
    planningState,
  ];
  async function plan(): Promise<Plan> {
    return JSON.parse(
      await command(helper, [...args, "--format", "json"], [2]),
    );
  }
  const action = (result: Plan, path: string) =>
    result.items.find((item) => item.path === path)?.action;
  async function localEvidence() {
    const entries = [...(await scanLocal(planningLocal))].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return JSON.stringify(
      entries.map(([path, entry]) => [
        path,
        entry,
        lstatSync(resolve(planningLocal, path), {
          bigint: true,
        }).mtimeNs.toString(),
      ]),
    );
  }
  async function remoteEvidence() {
    const evidence = [];
    for (const path of [
      "same.txt",
      "remote-only.txt",
      "conflict.txt",
      "nested/empty.txt",
    ]) {
      evidence.push(
        JSON.parse(
          await cloud("filesystem", "info", `${planningRoot}/${path}`),
        ),
      );
    }
    return JSON.stringify(evidence);
  }
  const beforeLocal = await localEvidence();
  const beforeRemote = await remoteEvidence();
  const first = await plan();
  writeFileSync(
    resolve(local, "first-plan.json"),
    `${JSON.stringify(first, null, 2)}\n`,
    { mode: 0o600 },
  );
  check(
    "recursive dry run reports matching, local-only, remote-only and conflicting content",
    first.remoteUpdate.mode === "bootstrap" &&
      first.remoteUpdate.listedFolders === 2 &&
      first.remoteUpdate.verifiedFiles === 4 &&
      action(first, "same.txt") === "unchanged" &&
      action(first, "nested/empty.txt") === "unchanged" &&
      action(first, "local-only.txt") === "upload" &&
      action(first, "remote-only.txt") === "download" &&
      action(first, "conflict.txt") === "conflict",
  );
  check(
    "dry run leaves local content/mtimes and remote metadata/revisions unchanged",
    beforeLocal === (await localEvidence()) &&
      beforeRemote === (await remoteEvidence()),
  );
  const second = await plan();
  check(
    "packaged planner reopens state and uses events without relisting existing folders",
    second.remoteUpdate.mode === "events" &&
      second.remoteUpdate.listedFolders === 0 &&
      second.remoteUpdate.verifiedFiles === 0 &&
      action(second, "conflict.txt") === "conflict",
  );
  const text = await command(helper, [...args, "--format", "text"], [2]);
  check(
    "human-readable dry run explains proposals and exits 2 for conflicts",
    text.startsWith("READ-ONLY DRY RUN:") &&
      text.includes('CONFLICT "conflict.txt":'),
  );
  writeFileSync(resolve(planningLocal, "same.txt"), "local changed\n");
  check(
    "matching baseline distinguishes a local-only content change",
    action(await plan(), "same.txt") === "upload",
  );
  await upload("same.txt", "remote changed too\n");
  check(
    "unapplied upload proposal is not acknowledged; later concurrent change stays a conflict",
    action(await plan(), "same.txt") === "conflict",
  );
  await upload("empty.txt", "remote changed\n", `${planningRoot}/nested`);
  const updated = await plan();
  check(
    "nested remote revision event proposes download without a recursive rescan",
    action(updated, "nested/empty.txt") === "download" &&
      updated.remoteUpdate.listedFolders === 0,
  );
  rmSync(resolve(planningLocal, "nested/empty.txt"));
  check(
    "missing previously matching local file requires review rather than deletion or restoration",
    action(await plan(), "nested/empty.txt") === "review",
  );
  await cloud("filesystem", "create-folder", planningRoot, "arrived");
  await upload("child.txt", "new subtree\n", `${planningRoot}/arrived`);
  const added = await plan();
  check(
    "newly entering folder is snapshotted without relisting the existing remote tree",
    action(added, "arrived") === "create-local-directory" &&
      action(added, "arrived/child.txt") === "download" &&
      added.remoteUpdate.listedFolders === 1,
  );
}

let created = false;
try {
  check(
    "separate browser session persists across helper processes",
    records(await command(helper, ["auth", "status"]))[0]?.authenticated ===
      true,
  );
  await cloud("filesystem", "create-folder", "/my-files", tag);
  created = true;
  report.cleanup = "pending";
  save();
  if (!values["planning-only"]) {
    const node = records(
      await command(helper, ["inspect", "--remote", remote]),
    )[0];
    check(
      "custom SDK host decrypts disposable folder metadata",
      !!node?.nodeUid,
    );
    const baseline = await once();
    check(
      "initial event cursor is durably checkpointed",
      baseline.some((row) => row.kind === "checkpoint" && !!row.cursor),
    );
    writeFileSync(file, "synthetic initial version\n");
    await cloud(
      "filesystem",
      "upload",
      file,
      remote,
      "--file-conflict-strategy",
      "create-new-revision",
      "--skip-thumbnails",
    );
    const uploaded: { uid: string } = JSON.parse(
      await cloud("filesystem", "info", `${remote}/${tag}.txt`),
    );
    const backlog = await once();
    check(
      "new process resumes and receives external CLI upload",
      backlog.some((row) => row.event?.nodeUid === uploaded.uid),
    );
    const scheduled = watch(45);
    try {
      await scheduled.ready;
      writeFileSync(file, "synthetic changed revision\n");
      await cloud(
        "filesystem",
        "upload",
        file,
        remote,
        "--file-conflict-strategy",
        "create-new-revision",
        "--skip-thumbnails",
      );
      await cloud(
        "filesystem",
        "rename",
        `${remote}/${tag}.txt`,
        `${tag}-renamed.txt`,
      );
      const exit = await scheduled.child.exited;
      await scheduled.consume;
      const error = await scheduled.stderr;
      if (exit !== 0) throw new Error(`Scheduled watcher failed: ${error}`);
      check(
        "SDK scheduler observes external updates/rename without tree rescans",
        scheduled.result.some(
          (row) =>
            row.event?.nodeUid === uploaded.uid &&
            row.event.type === "node_updated",
        ),
      );
    } finally {
      clearTimeout(scheduled.timeout);
      if (scheduled.child.exitCode === null) {
        scheduled.child.kill();
        await scheduled.child.exited;
      }
    }
    const interrupted = watch(120);
    try {
      await interrupted.ready;
      interrupted.child.kill("SIGKILL");
      await interrupted.child.exited;
      await interrupted.consume;
      await interrupted.stderr;
    } finally {
      clearTimeout(interrupted.timeout);
      if (interrupted.child.exitCode === null) {
        interrupted.child.kill();
        await interrupted.child.exited;
      }
    }
    await cloud("filesystem", "trash", `${remote}/${tag}-renamed.txt`);
    const resumed = await once();
    check(
      "checkpoint and SQLite lock recover after SIGKILL; offline trash is replayed",
      resumed.some(
        (row) =>
          row.event?.nodeUid === uploaded.uid &&
          (row.event.isTrashed === true || row.event.type === "node_deleted"),
      ),
    );
    await cloud("filesystem", "info", "/my-files");
    check("official CLI remains authenticated", true);
  }
  await validatePlanning();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  if (created) {
    try {
      report.cleanup = await trashFixture();
    } catch (error) {
      report.cleanup = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
      process.exitCode = 1;
      console.error(report.cleanup);
    }
  }
  save();
  console.log(`Private report: ${resolve(local, "report.json")}`);
}
