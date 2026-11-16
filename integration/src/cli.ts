import { mkdirSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { init } from "../../.local/proton-sdk/cli/src/init.ts";
import { getConfig } from "../../.local/proton-sdk/cli/src/config.ts";
import { CREDENTIALS_SERVICE } from "../../.local/proton-sdk/cli/src/credentials/constants.ts";
import {
  APP_VERSION,
  SDK_VERSION,
  KEYRING_SERVICE,
  validateEnvironment,
} from "./identity.ts";
import { readBatch } from "./events.ts";
import { EventStore } from "./store.ts";
import { reconcile, validatePlanPaths } from "./reconcile.ts";
import { synchronize, validateSyncPaths } from "./sync.ts";

const options = {
  appVersion: APP_VERSION,
  sdkVersion: SDK_VERSION,
  clientUidPrefix: "pdrive-sync-integration",
  enablePersistedEvents: false,
  enableConsoleLog: false,
  enableMetrics: false,
};

function output(value: unknown): void {
  console.log(JSON.stringify(value));
}

const usage = `Usage: pdrive-integration COMMAND
  auth login|logout|status
  inspect --remote /my-files/FOLDER
  events --remote /my-files/FOLDER --state FILE [--once|--watch --seconds N]
  plan --local DIRECTORY --remote /my-files/FOLDER --state FILE [--format text|json]
  sync --apply --local DIRECTORY --remote /my-files/FOLDER --state FILE [--format text|json]
  version

plan is read-only: it never applies transfers or deletions. Its state file must
be outside the local root and separate from event-journal state. Unverified
remote revisions are streamed and hashed once, which may use substantial bandwidth.
sync --apply recomputes its plan; conflicts and missing entries remain untouched.
Recovery copies/staging are retained beside the state file in FILE.files/.
Exit codes: 0 = completed; 2 = review/skipped entries; 1 = incomplete/failed operation.`;

async function main(): Promise<void> {
  process.umask(0o077);
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      remote: { type: "string" },
      local: { type: "string" },
      state: { type: "string" },
      format: { type: "string", default: "text" },
      once: { type: "boolean" },
      watch: { type: "boolean" },
      seconds: { type: "string", default: "120" },
      help: { type: "boolean", short: "h" },
      apply: { type: "boolean" },
    },
  });
  const [command, action] = positionals;
  if (values.help || (command === "help" && positionals.length === 1)) {
    console.log(usage);
    return;
  }
  if (command === "version" && positionals.length === 1) {
    output({
      appVersion: APP_VERSION,
      sdkVersion: SDK_VERSION,
      bun: Bun.version,
    });
    return;
  }
  if (
    !["auth", "inspect", "events", "plan", "sync"].includes(command ?? "") ||
    (command === "auth" &&
      !["login", "logout", "status"].includes(action ?? "")) ||
    positionals.length !== (command === "auth" ? 2 : 1)
  ) {
    throw new Error(usage);
  }
  if (
    (command === "sync" && !values.apply) ||
    (command !== "sync" && values.apply)
  ) {
    throw new Error(
      "Only sync --apply authorizes file changes; plan remains read-only.",
    );
  }
  if (values.once && values.watch) {
    throw new Error("--once and --watch are mutually exclusive.");
  }
  if (
    command !== "auth" &&
    (!values.remote?.startsWith("/my-files/") ||
      values.remote === "/my-files/" ||
      (["events", "plan", "sync"].includes(command ?? "") && !values.state))
  ) {
    throw new Error(
      "An explicit My files subfolder and event-state file are required.",
    );
  }
  if (
    ["plan", "sync"].includes(command ?? "") &&
    (!values.local || !["text", "json"].includes(values.format ?? ""))
  ) {
    throw new Error(
      "plan/sync requires --local DIRECTORY and --format text|json.",
    );
  }
  if (
    ["plan", "sync"].includes(command ?? "") &&
    (values.once || values.watch || values.seconds !== "120")
  ) {
    throw new Error(
      "plan/sync is a single operation; watch options are not supported.",
    );
  }
  const seconds = Number(values.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("--seconds must be an integer from 1 to 3600.");
  }
  validateEnvironment(process.env);
  const config = getConfig(options);
  if (
    config.authClientId !== "external-drive" ||
    CREDENTIALS_SERVICE !== KEYRING_SERVICE
  ) {
    throw new Error(
      "The reference host is not isolated or honestly identified.",
    );
  }
  if (command === "plan" || command === "sync") {
    if (!values.local || !values.state || !values.remote) {
      throw new Error("plan/sync requires --local, --remote, and --state.");
    }
    const validate = command === "sync" ? validateSyncPaths : validatePlanPaths;
    await validate({
      local: values.local,
      remote: values.remote,
      state: values.state,
      privateDirectories: [config.appDir, config.cacheDir, config.logDir],
    });
  }
  for (const directory of [config.appDir, config.cacheDir, config.logDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    ) {
      throw new Error(
        `Application directory must be owned by you and private: ${directory}`,
      );
    }
  }
  const host = await init(options);
  try {
    if (command === "auth") {
      if (action === "status") {
        output({
          authenticated: host.auth.isLoggedIn(),
          service: KEYRING_SERVICE,
        });
      } else if (action === "logout") {
        await host.auth.logout();
        output({ authenticated: false });
      } else {
        console.error(
          "This is a third-party application not officially supported by Proton.",
        );
        console.error(
          "Sign in in your browser; the helper uses its own OS-keyring session.",
        );
        await host.auth.authViaWeb(async (url) => {
          const browser = Bun.spawn(["xdg-open", url], {
            stdout: "ignore",
            stderr: "ignore",
          });
          if ((await browser.exited) !== 0) {
            throw new Error(
              "Could not open the browser. No sign-in URL was logged.",
            );
          }
        });
        output({ authenticated: true, service: KEYRING_SERVICE });
      }
      return;
    }
    if (!host.auth.isLoggedIn()) {
      throw new Error("No pdrive_sync session. Run auth login first.");
    }
    if (!values.remote) {
      throw new Error("--remote is required.");
    }
    const node = await host.paths.getNode(values.remote);
    if (node.type !== "folder") {
      throw new Error("--remote must identify a folder.");
    }
    if (!node.parentUid) {
      throw new Error("Select a disposable subfolder, not the account root.");
    }
    if (command === "inspect") {
      output({ nodeUid: node.uid, scope: node.treeEventScopeId });
      return;
    }
    if (!values.state) {
      throw new Error("--state is required.");
    }
    if (command === "sync") {
      if (!values.local) throw new Error("--local is required.");
      const result = await synchronize(host.sdk, node, {
        local: values.local,
        remote: values.remote,
        state: values.state,
        privateDirectories: [config.appDir, config.cacheDir, config.logDir],
      });
      if (values.format === "json") {
        output(result);
      } else {
        console.log(
          "EXPLICIT ONE-SHOT SYNC: deletions disabled; conflicts are left untouched.",
        );
        for (const item of result.results) {
          console.log(
            `${item.status.toUpperCase()} ${item.action} ${JSON.stringify(item.path)}: ${item.reason}${item.recovery ? ` Recovery: ${JSON.stringify(item.recovery)}` : ""}`,
          );
        }
        console.log(`Summary: ${JSON.stringify(result.summary)}`);
      }
      if (result.results.some((item) => item.status === "failed"))
        process.exitCode = 1;
      else if (
        result.pending.length ||
        result.results.some((item) =>
          ["skipped", "review"].includes(item.status),
        )
      )
        process.exitCode = 2;
      return;
    }
    if (command === "plan") {
      if (!values.local) throw new Error("--local is required.");
      const plan = await reconcile(host.sdk, node, {
        local: values.local,
        remote: values.remote,
        state: values.state,
        privateDirectories: [config.appDir, config.cacheDir, config.logDir],
      });
      if (values.format === "json") {
        output(plan);
      } else {
        console.log(
          "READ-ONLY DRY RUN: no local or remote content is changed.",
        );
        console.log(
          `Local: ${JSON.stringify(plan.roots.local)}\nRemote: ${JSON.stringify(plan.roots.remote)}`,
        );
        console.log(
          `Remote metadata: ${plan.remoteUpdate.mode}; ${plan.remoteUpdate.events} events`,
        );
        console.log(
          `Remote content verification: ${plan.remoteUpdate.verifiedFiles} revisions, ${plan.remoteUpdate.verifiedBytes} bytes read`,
        );
        for (const item of plan.items) {
          console.log(
            `${item.action.toUpperCase()} ${JSON.stringify(item.path)}: ${item.reason}`,
          );
        }
        for (const pending of plan.pending) {
          console.log(
            `PENDING ${pending.action} ${JSON.stringify(pending.path)}: interrupted transfer requires recovery checks. Recovery: ${JSON.stringify(pending.artifact)}`,
          );
        }
        console.log(`Summary: ${JSON.stringify(plan.summary)}`);
      }
      if (
        plan.pending.length ||
        plan.items.some((item) =>
          ["conflict", "review", "unsupported"].includes(item.action),
        )
      ) {
        process.exitCode = 2;
      }
      return;
    }
    const store = new EventStore(
      resolve(values.state),
      node.treeEventScopeId,
      node.uid,
    );
    const abort = new AbortController();
    try {
      const poll = async () => {
        const count = await readBatch(
          store,
          host.sdk.iterateEvents(store.scope, store.cursor, abort.signal),
          (event) => output({ kind: "event", event }),
        );
        output({
          kind: "checkpoint",
          cursor: store.cursor,
          received: count,
          total: store.eventCount,
        });
      };
      if (!store.initialized) {
        if (!store.cursor) {
          await poll();
        }
        const children: string[] = [];
        for await (const child of host.sdk.iterateFolderChildren(node)) {
          children.push(child.uid);
        }
        store.seed(children);
      }
      if (!values.watch) {
        await poll();
        return;
      }
      const stop = Promise.withResolvers<void>();
      let pending: Promise<void> = Promise.resolve();
      let failure: unknown;
      let stopping = false;
      const scheduler = await host.sdk.getEventScheduler(() => {
        pending = poll().catch((error: unknown) => {
          if (!(
            stopping &&
            error instanceof Error &&
            error.name === "AbortError"
          )) {
            failure = error;
          }
          stop.resolve();
        });
        return pending;
      });
      const timer = setTimeout(() => {
        stopping = true;
        stop.resolve();
      }, seconds * 1000);
      const onStop = () => {
        stopping = true;
        abort.abort();
        stop.resolve();
      };
      process.once("SIGINT", onStop);
      process.once("SIGTERM", onStop);
      scheduler.addScope(store.scope);
      output({ kind: "watching", seconds });
      await stop.promise;
      clearTimeout(timer);
      abort.abort();
      await pending;
      await new Promise<void>((done) => setImmediate(done));
      scheduler.removeScope(store.scope);
      process.removeListener("SIGINT", onStop);
      process.removeListener("SIGTERM", onStop);
      if (failure) {
        throw failure;
      }
    } finally {
      store.close();
    }
  } finally {
    await host.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
