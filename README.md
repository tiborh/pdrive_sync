# pdrive_sync

An experimental, unofficial Linux folder synchronization project for Proton Drive.

**This project is a stop-gap measure until Proton's official Linux synchronization
implementation is ready to use.** It is not intended to compete with or permanently
replace the official client.

This is a third-party project, not affiliated with, endorsed by, or officially
supported by Proton AG.

## Status

**Early research and project setup. There is no working sync application yet.**
Do not rely on this project as your only backup.

The initial goal is a CLI that synchronizes a local directory, such as
`~/Dropbox/`, with a dedicated folder in Proton Drive. A background service and
Linux tray interface may follow once the synchronization engine is dependable.
Neither Dropbox compatibility nor use of Dropbox's service is intended.

Do not run two independent sync clients against the same local directory during
migration: changes and deletions can feed back between them.

See the [roadmap](ROADMAP.md) for milestones and acceptance criteria. Initial
capability validation and repository setup are complete; implementation is next.

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
errors, bounded concurrency, and retry backoff. Credentials should remain managed
by the official Proton CLI and operating system rather than this application.

**Remote change detection is an unresolved prerequisite for a background sync
service.** Proton's integration guidelines require event-based synchronization
and prohibit frequent recursive tree scans. The installed CLI did not expose a
remote event-watch command in its command set. We must establish a supported
event-driven approach; an SDK-backed component may be necessary instead of a
pure CLI wrapper. Frequent whole-tree polling is not the proposed solution.

## Language and runtime

**TypeScript is the provisional language choice, with Bun as the candidate
runtime.** This favors the native Proton SDK and the existing official CLI's
integration approach over maintaining a second-language event bridge.

See the [language-selection study](docs/language-selection.md) for alternatives,
completed offline compatibility checks, remaining integration gates, and the
conditions under which the language or runtime can change. Authentication and
live event handling are not yet validated for our own SDK integration.

## Proton integration requirements

Proton's current SDK documentation allows personal, non-commercial projects under
its integration guidelines and describes commercial or production third-party
integration as not yet ready. This project's initial scope is experimental,
personal-use integration.

Any implementation must respect Proton's current service terms and operational
requirements, including event-based synchronization, caching, rate limits,
backoff, official endpoints, and honest application identification. Custom
clients or forked CLI builds must not impersonate an official Proton client.
Identification requirements for a separately branded wrapper invoking the
unmodified official CLI still need clarification.

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
the event-driven integration question, reproducible tests using synthetic data,
and a non-destructive reconciliation design.

Never commit credentials, session tokens, keyring exports, personal file listings,
raw account logs, or synchronization databases. Integration tests must use an
explicitly selected disposable directory, not a contributor's real sync folder.

### Development checks

The current repository contains documentation rather than application code.
The Node.js tooling below is for documentation checks only, separate from the
provisional application language and runtime decision.

With Node.js 22 or newer and npm installed:

```sh
npm ci --ignore-scripts
npm run lint:docs
```

GitHub Actions runs Markdown linting, dependency auditing, and workflow validation
on pull requests and pushes to `main`. Workflows can also be validated locally
with Go 1.25 or newer:

```sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color
```

CI uses read-only repository permissions and requires no Proton credentials.
Dependabot checks npm dependencies and GitHub Actions references weekly.
The dependency audit blocks moderate or higher severity advisories. The current
Markdown tooling has a transitive, low-severity
[KaTeX advisory](https://github.com/advisories/GHSA-238p-pmpm-9mq7); we retain the
upstream-supported dependency versions rather than forcing an incompatible
override. These dependencies are development tools, not application dependencies.
Application linting, type checks, and offline tests will be added with the first
application code rather than introducing placeholder test jobs.

## License

This repository is licensed under the [MIT License](LICENSE).

That license covers this project's code and documentation. It does not grant
rights to Proton trademarks or override Proton's terms for its hosted services.
Any reused upstream code must retain its applicable license notices.
