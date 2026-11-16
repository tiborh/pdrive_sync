import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { APP_VERSION, SDK_VERSION } from "../src/identity.ts";

if (process.env.PDRIVE_ALLOW_LIVE_TESTS !== "1") {
  throw new Error("Live validation is opt-in: set PDRIVE_ALLOW_LIVE_TESTS=1.");
}
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
async function command(executable: string, args: string[]): Promise<string> {
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
  if (code !== 0)
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
  const node = records(
    await command(helper, ["inspect", "--remote", remote]),
  )[0];
  check("custom SDK host decrypts disposable folder metadata", !!node?.nodeUid);
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
