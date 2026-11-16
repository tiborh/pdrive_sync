# Proton integration qualification

**Milestone complete for an experimental personal-use integration, not a working
sync client or Proton-endorsed production application.** TypeScript/Bun is the
initial implementation baseline. Read-only reconciliation is next.

## Selected approach

Use the exported TypeScript SDK `iterateEvents()` and `getEventScheduler()` APIs,
hosted by the official CLI's initialization code at the pinned SDK 0.23.0 release:
`8a44654aece1609f0f7218be51c205103945abd8`.

The installed official CLI has no event-watch command. A pure subprocess wrapper
therefore does not meet the background-sync requirement. SDK-managed polling of
the change feed does: it is not periodic recursive folder scanning.

Authentication is outside the public Drive SDK. The helper reuses the release's
**incubating reference account host**, not a promised stable authentication API.
Its only source modifications change the application-directory and keyring
namespaces. We do not implement password handling or raw Drive API calls.
Upstream compatibility and service terms still need review on every upgrade.

The helper sends `external-drive-pdrive_sync@0.1.0-alpha` and the matching SDK
version `js@0.23.0+8a44654`. The reference host selects its `external-drive`
authentication client for that identity. This is honest third-party
identification, not a claim that Proton has approved this project.

## Credentials and private state

Browser authorization creates a separate OS-keyring session under service
`pdrive_sync/integration-session`, item `auth-session`. No existing official CLI
session is copied, read, overwritten, or logged out.

The helper uses `pdrive_sync-integration` directories under the XDG data, cache,
and state locations resolved by the reference host. Application directories must
be private, owned by the current user, and not symlinks. The process uses a private
umask. Proxy API endpoints, shared cache overrides, plaintext credential stores,
and unsafe crypto caches are rejected. Telemetry and console host logging are
disabled; any reference-host file logs remain private.

Login opens the browser using `xdg-open`; sensitive authorization URLs are not
printed. Linux requires an available, unlocked OS secret service/libsecret
keyring and a browser. Headless/boot-time keyring access is not yet qualified.
Use `auth logout` to revoke the helper's local session when no longer needed.

Event databases, helper output, and live reports contain account metadata.
Keep them private and out of Git. Build artifacts, downloaded reference source,
and local validation artifacts are ignored by this repository.

## Build and offline checks

Requirements: Linux x86-64, Git, npm/Node, and Bun **1.4.2** on `PATH`.

```sh
cd integration
npm ci --ignore-scripts
npm run prepare:upstream
npm run check
npm test
npm run build
./dist/pdrive-integration version
```

Preparation fetches a sparse, pinned checkout into `.local/proton-sdk`, verifies
the expected source modifications, and installs the reference host's frozen Bun
lock with lifecycle scripts disabled. The original package registry was
unreachable during qualification, so preparation substitutes only its URL prefix
with `registry.npmjs.org`, retaining locked versions and integrity hashes.
This does not change Proton service endpoints.

A controlled `node_modules` symlink lets the linked reference packages resolve
the same dependency graph. Unexpected checkout origins, revisions, tracked
modifications, or shared-dependency layouts fail explicitly, without resetting
someone else's checkout. The release host uses crypto 2.0.0 and its upstream
patch; do not substitute the separate language study's crypto 2.2.0 smoke setup.

The compiled `integration/dist/pdrive-integration` embeds Bun and targets baseline
Linux x86-64 rather than requiring AVX2. Distribute its `LICENSE`,
`PROTON-LICENSE`, and `THIRD-PARTY-NOTICES` together with it. Other architectures,
Linux distributions, and native-library combinations remain unqualified.

CI checks our development dependencies with npm audit, plus types, lint,
formatting, offline tests, executable build, license presence, and version output.
CodeQL scans our TypeScript, not the downloaded reference checkout; Bun-specific
APIs may not be fully modeled. CI never authenticates or runs the live harness.
Dependabot updates our npm tooling and Actions, not the manually pinned upstream
source or its frozen dependency graph. Those need coordinated security and
compatibility review when upgrading.

## Manual helper use

Authenticate separately, then select an explicit disposable My files subfolder:

```sh
./dist/pdrive-integration auth login
./dist/pdrive-integration auth status
./dist/pdrive-integration inspect --remote /my-files/pdrive-test
./dist/pdrive-integration events --remote /my-files/pdrive-test \
  --state ../.local/manual/events.sqlite --once
./dist/pdrive-integration events --remote /my-files/pdrive-test \
  --state ../.local/manual/events.sqlite --watch --seconds 120
```

Create that disposable folder yourself before using these commands. The helper
does not upload, download, rename, or trash files. Watch duration is bounded to
1–3600 seconds; it is not a daemon. Output is diagnostic JSON, not a stable
synchronization-operation protocol.

## Event and crash behavior

The helper monitors the selected root and known **direct children only**.
It obtains an event baseline before one initial direct-child snapshot and then
catches up. It does not recursively monitor descendants or periodically rescan
the tree. Known-child moves out of the selected folder and trash/deletion remove
membership so later outside-folder changes are ignored.

SQLite stores journal identities and the cursor with full synchronous durability
and an exclusive connection lock. State is bound to the selected root and event
scope. Multiple changes can share a cursor, so it advances only after the entire
async event batch finishes. Interrupted batches replay with duplicate suppression.
This journal is not yet a durable operation queue with consumer acknowledgements:
stdout delivery must not be used as evidence that synchronization work completed.

Unexpected scopes fail explicitly. Tree refresh, tree removal, and selected-root
deletion persist a blocking reason without advancing the checkpoint. They require
a fresh snapshot or access recovery; automatic safe recovery belongs to later
milestones. Do not delete state and infer that missing files should be removed.

## Qualification evidence

Eight offline tests passed, including interrupted batches with shared cursors,
restart/replay, refresh/removal blocking, scope binding, exclusive state access,
membership filtering, and isolated identity/environment configuration.

Seven opt-in live checks passed using only randomly named synthetic fixtures:

1. Separate browser login persisted across helper processes.
2. The reference host decrypted the disposable folder's metadata.
3. An initial event cursor was durably checkpointed.
4. A new helper process received an upload made through the official CLI.
5. The SDK scheduler observed external updates/rename without tree rescans.
6. After SIGKILL, SQLite reopened and replayed trash activity made while offline.
7. The official CLI remained authenticated.

The compiled helper also resumed its own keyring session from an empty directory
with no Node/Bun on `PATH`. Synthetic cloud fixtures were verified in trash, not
permanently deleted. No real Dropbox files were accessed and Dropbox was not
stopped. Private reports and account identifiers are not published.

To repeat the live suite, first authenticate both the helper and the official
`proton-drive` CLI, then explicitly opt in from `integration/`:

```sh
PDRIVE_ALLOW_LIVE_TESTS=1 bun scripts/validate-live.ts
```

This command **writes synthetic cloud data**, observes it with the helper, and
moves its randomly named folder to trash. It does not empty trash. Cleanup
failure is reported as failure, with a private report under `.local/validation/`.
It is a targeted integration test, not a large-tree, multi-writer, transfer-safety,
or unattended-service qualification.

## Upstream references

- [Pinned SDK and integration guidelines][sdk]
- [Pinned reference CLI and application identification][cli]
- [Public SDK client/event interfaces][events]
- [Incubating account host][account]
- [Proton service terms](https://proton.me/legal/terms)

[sdk]: https://github.com/ProtonDriveApps/sdk/tree/8a44654aece1609f0f7218be51c205103945abd8
[cli]: https://github.com/ProtonDriveApps/sdk/blob/8a44654aece1609f0f7218be51c205103945abd8/cli/README.md
[events]: https://github.com/ProtonDriveApps/sdk/blob/8a44654aece1609f0f7218be51c205103945abd8/client/js/src/protonDriveClient.ts
[account]: https://github.com/ProtonDriveApps/sdk/tree/8a44654aece1609f0f7218be51c205103945abd8/incubating/account/js
