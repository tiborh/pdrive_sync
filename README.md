# pdrive_sync

An experimental, unofficial Linux folder synchronization project for Proton Drive.

**This project is a stop-gap measure until Proton's official Linux synchronization
implementation is ready to use.** It is not intended to compete with or permanently
replace the official client.

This is a third-party project, not affiliated with, endorsed by, or officially
supported by Proton AG.

## Status

**Event integration qualified; there is no working sync application yet.**
Do not rely on this project as your only backup.

The initial goal is a CLI that synchronizes a local directory, such as
`~/Dropbox/`, with a dedicated folder in Proton Drive. A background service and
Linux tray interface may follow once the synchronization engine is dependable.
Neither Dropbox compatibility nor use of Dropbox's service is intended.

Do not run two independent sync clients against the same local directory during
migration: changes and deletions can feed back between them.

See the [roadmap](ROADMAP.md) for milestones and acceptance criteria. Initial
capability validation, repository setup, and the event-integration milestone are
complete. Read-only reconciliation is next.

## Capability validation

An isolated capability study on November 15, 2026, using the official Proton Drive
CLI 0.9.0, completed 27 checks across two successful validation runs. This was
performed separately from this repository; account-specific reports, local
paths, credentials, and test data are not included here.

Validated building blocks:

- Uploads and downloads, including hidden files, empty files and directories,
  Unicode and punctuation-bearing filenames, nested directories, and a 5 MiB file.
- JSON folder listings with file identity, revision identity, and content hashes.
- Identical uploads that leave the active revision unchanged, and changed uploads
  that create a new revision while preserving file identity.
- Rename and move operations that preserve file and revision identity.
- Explicit conflict handling, trash and restore, and non-interactive errors.
- Partially successful transfers with a nonzero exit code and per-item results.

Important findings:

- Downloads did not preserve source modification times. Reconciliation must use
  persistent state and content/revision information, not timestamps alone.
- Trash restore by UID failed; the inspected CLI implementation resolves trash
  entries by name. Duplicate names require special care.
- Uploading a directory containing a symlink failed. Symlinks need explicit
  handling before transfers are queued.
- Some errors were not JSON even with JSON output enabled. Exit status, stderr,
  and per-item outcomes must all be checked.
- Successful per-folder listings had a median duration of approximately
  2.4 seconds in the small test fixture. This is not a large-tree benchmark.
- Concurrent-writer safety, interruption recovery, boot-time keyring access,
  large-tree performance, and non-content filesystem metadata remain unvalidated.

These results demonstrate transfer primitives, not a complete or safe sync engine.

## Design direction

The first implementation milestone is **read-only reconciliation and dry-run
output**, with no changes to real local or remote files.

The intended safety model includes persistent synchronization state, preservation
of conflicting versions, staged downloads, recoverable deletions, explicit
errors, bounded concurrency, and retry backoff.

The experimental [integration helper](docs/proton-integration.md) uses exported
SDK event APIs through a pinned, incubating reference CLI host. It has its own
browser-authorized session in the OS keyring, without sharing the official CLI's
credentials. Live change detection and crash/restart replay passed isolated
checks. It monitors one selected folder and its direct children, not a recursive
sync tree. Frequent whole-tree polling is not the proposed solution.

## Language and runtime

**TypeScript and Bun are the qualified initial implementation baseline.**
This favors the native Proton SDK and the existing official CLI's
integration approach over maintaining a second-language event bridge.

See the [language-selection study](docs/language-selection.md) for alternatives,
completed compatibility and live integration checks, remaining limitations, and
the conditions under which the language or runtime can change.

## Proton integration requirements

Proton's current SDK documentation allows personal, non-commercial projects under
its integration guidelines and describes commercial or production third-party
integration as not yet ready. This project's initial scope is experimental,
personal-use integration.

Any implementation must respect Proton's current service terms and operational
requirements, including event-based synchronization, caching, rate limits,
backoff, official endpoints, and honest application identification. Custom
clients or forked CLI builds must not impersonate an official Proton client.
The helper identifies itself as `external-drive-pdrive_sync@0.1.0-alpha` and uses
the reference host's `external-drive` authentication selection, rather than
impersonating the official CLI. The official CLI is used separately to mutate
synthetic fixtures in opt-in validation, not as the application's event adapter.

The project will not use Proton logos or official product styling and will remain
clearly identified as unofficial. Users should review the current upstream rules
rather than treating this README as legal clearance or a promise of service access.

References:

- [Proton Drive CLI announcement](https://proton.me/blog/proton-drive-cli)
- [SDK integration guidelines](https://github.com/ProtonDriveApps/sdk#usage-guidelines-for-personal-projects)
- [CLI documentation and application identification](https://github.com/ProtonDriveApps/sdk/blob/main/cli/README.md)
- [Proton Terms of Service](https://proton.me/legal/terms)

## Contributing

The project is not ready for general use. Initial contributions should focus on
read-only reconciliation, reproducible tests using synthetic data,
and a non-destructive reconciliation design.

Never commit credentials, session tokens, keyring exports, personal file listings,
raw account logs, or synchronization databases. Integration tests must use an
explicitly selected disposable directory, not a contributor's real sync folder.

### Development checks

The root Node.js tooling checks documentation. The `integration/` project contains
the experimental TypeScript/Bun helper, not a user-ready synchronization engine.

With Node.js 22 or newer and npm installed:

```sh
npm ci --ignore-scripts
npm run lint:docs
```

With Bun 1.4.2, Git, and npm, check and build the integration separately:

```sh
cd integration
npm ci --ignore-scripts
npm run prepare:upstream
npm run check
npm test
npm run build
./dist/pdrive-integration version
```

See the [integration notes](docs/proton-integration.md) before authenticating or
running opt-in live tests. GitHub Actions runs these offline checks and build,
Markdown linting, dependency auditing, workflow validation, and TypeScript CodeQL.
Workflows can also be validated locally with Go 1.25 or newer:

```sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color
```

CI requires no Proton credentials. Jobs use read-only repository contents;
CodeQL additionally has permission to upload security results.
Dependabot checks both npm projects and GitHub Actions references weekly.
The npm dependency audits block moderate or higher severity advisories. The current
Markdown tooling has a transitive, low-severity
[KaTeX advisory](https://github.com/advisories/GHSA-238p-pmpm-9mq7); we retain the
upstream-supported dependency versions rather than forcing an incompatible
override. These dependencies are development tools, not application dependencies.
The separately pinned upstream source and its frozen dependency graph require
manual review and coordinated updates; Dependabot does not update that source pin.

## License

This repository is licensed under the [MIT License](LICENSE).

That license covers this project's code and documentation. It does not grant
rights to Proton trademarks or override Proton's terms for its hosted services.
Any reused upstream code must retain its applicable license notices.
