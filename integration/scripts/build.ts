import { mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { UPSTREAM_REVISION } from "../src/identity.ts";

const integration = resolve(import.meta.dir, "..");
const upstream = resolve(integration, "../.local/proton-sdk");
const dist = resolve(integration, "dist");
mkdirSync(dist, { recursive: true });
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    "--bytecode",
    "--target=bun-linux-x64-baseline",
    resolve(integration, "src/cli.ts"),
    "--outfile",
    resolve(dist, "pdrive-integration"),
  ],
  { cwd: integration, stdout: "inherit", stderr: "inherit" },
);
if ((await child.exited) !== 0) {
  throw new Error("Integration executable build failed.");
}
copyFileSync(resolve(upstream, "LICENSE.md"), resolve(dist, "PROTON-LICENSE"));
copyFileSync(resolve(integration, "../LICENSE"), resolve(dist, "LICENSE"));
const notice = `Built with Proton Drive SDK/CLI reference code, MIT licensed.
Copyright (c) 2025-2026 Proton AG.
Upstream: https://github.com/ProtonDriveApps/sdk
Revision: ${UPSTREAM_REVISION}
Local changes: separate application directories and keyring namespace.
Build adaptation: public npm mirror retaining locked versions and integrity hashes.
This is an unofficial experimental third-party application.
`;
await Bun.write(resolve(dist, "THIRD-PARTY-NOTICES"), notice);
if (!readFileSync(resolve(dist, "PROTON-LICENSE"), "utf8").includes("MIT")) {
  throw new Error("Upstream license notice missing.");
}
