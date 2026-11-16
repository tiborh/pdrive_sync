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

async function main(): Promise<void> {
  process.umask(0o077);
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      remote: { type: "string" },
      state: { type: "string" },
      once: { type: "boolean" },
      watch: { type: "boolean" },
      seconds: { type: "string", default: "120" },
    },
  });
  const [command, action] = positionals;
  if (command === "version" && positionals.length === 1) {
    output({
      appVersion: APP_VERSION,
      sdkVersion: SDK_VERSION,
      bun: Bun.version,
    });
    return;
  }
  if (
    (command !== "auth" && command !== "inspect" && command !== "events") ||
    (command === "auth" &&
      !["login", "logout", "status"].includes(action ?? "")) ||
    positionals.length !== (command === "auth" ? 2 : 1)
  ) {
    throw new Error(
      "Usage: pdrive-integration auth login|logout|status; inspect --remote PATH; events --remote PATH --state FILE [--once|--watch --seconds N]",
    );
  }
  if (values.once && values.watch) {
    throw new Error("--once and --watch are mutually exclusive.");
  }
  if (
    command !== "auth" &&
    (!values.remote?.startsWith("/my-files/") ||
      values.remote === "/my-files/" ||
      (command === "events" && !values.state))
  ) {
    throw new Error(
      "An explicit My files subfolder and event-state file are required.",
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
