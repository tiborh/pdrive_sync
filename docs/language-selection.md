# Language and runtime selection

Date: November 15, 2026.

**Status: provisional. Prefer TypeScript, with Bun as the candidate runtime.**
Offline compatibility checks passed, but authentication and live event handling
must pass an integration spike before this becomes the implementation baseline.
There is no working sync application yet.

## What drives the choice

This is a stop-gap project. Reducing integration and maintenance work matters more
than optimizing for hypothetical throughput or reproducing every Dropbox feature.
The [roadmap](../ROADMAP.md) requires safe reconciliation, persistent state,
event-driven remote updates, Linux background operation, and an optional tray
interface.

The strongest constraint is Proton integration:

- Proton provides native SDKs in TypeScript and C#. Its official CLI uses
  TypeScript and Bun, giving us a closely related integration reference.
- The TypeScript SDK exposes `iterateEvents()` and `getEventScheduler()`.
  This addresses remote change detection without frequent recursive tree scans.
  SDK-managed polling of an event feed is different from repeatedly scanning
  folders; event-driven does not necessarily mean a server-pushed connection.
- TypeScript allows the adapter and reconciliation engine to share typed event
  and metadata definitions without a second-language bridge.
- Type checking helps with event states, but does not prove runtime input
  validity, crash consistency, or conflict safety. Those require validation and
  failure-oriented tests regardless of language.

The earlier Python suggestion assumed a thin wrapper around the unmodified CLI.
The event integration requirement makes that assumption insufficient for the
background-service milestone. No programming language can supply an event
interface that the CLI does not expose.

## Alternatives

- **TypeScript:** preferred for its native SDK and alignment with the official
  CLI. Runtime, account integration, and dependency complexity remain.
- **C#/.NET:** a strong alternative with a native SDK, strong typing, and
  background-service tooling, but less direct reuse of the Linux CLI integration.
- **Python:** simple CLI, SQLite, and Linux desktop development. No native SDK is
  listed; best if a supported CLI-only approach makes an event bridge unnecessary.
- **Go:** good native CLI distribution and daemon operation, but no native SDK
  is listed. Reconsider for a demonstrated deployment requirement.
- **Rust:** native distribution and memory safety, but no native SDK is listed.
  The additional integration work is not justified for the current stop-gap scope.

A bridge is possible, but adds process supervision, an IPC protocol, coordinated
shutdown, error propagation, and multi-runtime packaging. Avoid it unless it
solves a concrete requirement that outweighs those costs.

## Language is not runtime or package-manager selection

TypeScript is the language recommendation. Bun is the initial runtime candidate
because it matches the official CLI and can compile a Linux executable.
Node.js remains an alternative if the integration works better there.

Do not assume that a Bun build is dependency-free or supported on every Linux
system. Keyring integration, native libraries, CPU compatibility, distribution
compatibility, and final application packaging still need validation.

The production package-manager and lockfile choice must accommodate the SDK's
actual dependency and patch requirements. The repository's current npm manifest
and lockfile are documentation tooling, not an application dependency decision.

## Checks completed before recording this decision

The checks used an isolated workspace with synthetic data. They did not log in,
read credentials, contact a Proton account, or access a real sync directory.
The SDK client was imported but not instantiated.

Tested versions: `@protontech/drive-sdk` 0.23.0, `@protontech/crypto` 2.2.0,
TypeScript 5.9.3, and Bun / Bun types 1.4.2, on Linux x86-64.

| Check | Result and scope |
| --- | --- |
| Install published dependencies | Passed; lifecycle scripts disabled |
| Import the SDK under Bun | Passed |
| Check event methods and discriminants | Passed for types and method availability |
| Reopen a SQLite event-cursor fixture | Passed for synthetic local state |
| Type-check the smoke program | Passed with the upstream patch/settings below |
| Compile a Linux executable with Bun | Passed |
| Run without source files or a runtime on `PATH` | Passed with an empty directory/home |

The dependency check exposed a real qualification: the unpatched crypto package
failed type checking. The successful check used Proton's exact crypto 2.2.0 patch
and the upstream compiler settings `allowImportingTsExtensions: true` and
`skipLibCheck: true`, while retaining `strict: true`. This is not a clean,
patch-free installation or a full validation of third-party declarations.
Application code must not paper over these issues with unsafe casts.

The tested patch's SHA-256 was
`d3c125a570c045cf0f35ce02f1ee3e22f029700fdf013171954126d9aa7e4761`.
It was compared byte-for-byte with the upstream patch before use.

These are compatibility smoke checks, not proof that encryption, login, live
events, file transfers, or a full sync engine work through our own SDK integration.
The earlier official-CLI transfer validation is separate evidence and must not be
treated as validation of a new SDK-backed application.

## GitHub tooling

GitHub Actions, CodeQL, and Dependabot support the principal ecosystems considered
here. GitHub tooling is not a reason to reject Python, C#, Go, or Rust; native SDK
compatibility is the stronger differentiator.

If TypeScript is confirmed, add strict type checking, ESLint, formatting, offline
unit tests, and CodeQL with application code. Keep runtime-specific smoke tests:
Node-only tests cannot validate Bun deployment, and TypeScript CodeQL support is
not a guarantee that every Bun-specific API is modeled.

Configure dependency updates for the actual production manifests and lockfiles,
checking version-update and security-update coverage separately. Keep ordinary CI
credential-free; live integration tests remain explicitly opt-in.

## Confirmation criteria

The next integration spike must establish:

- A supported authentication/session approach and honest application identity.
  Importing the SDK does not establish access to an existing CLI login.
- Remote events for a disposable folder through exported SDK interfaces.
- Persisted event cursors that resume correctly after a process restart,
  including required refresh handling.
- A packaged Linux executable with the real authentication, crypto, and event
  dependencies, plus identified runtime and keyring requirements.

The SDK excludes authentication/session management, and the CLI's account module
is currently private and incubating. Upstream API and cryptographic changes are
additional maintenance risks. Do not copy private implementation details and
describe them as a stable public API.

## How the decision can change

Revisit the decision when evidence changes, not merely when another language is
preferred:

- A supported official CLI event interface makes a simple Python wrapper viable.
- TypeScript authentication or packaging remains impractical, while the C# SDK
  demonstrates a simpler supported integration.
- Supported SDKs or APIs become available in another language.
- Profiling or target-system tests reveal a concrete resource or deployment
  requirement that the selected runtime cannot meet.
- Upstream SDK changes alter compatibility or maintenance cost.
- Proton's official Linux implementation becomes ready to use; prefer a safe
  migration or retirement over an unnecessary rewrite.

Keep the reconciliation rules independent of the Proton adapter and keep an
optional tray controller separate from synchronization. These boundaries reduce
replacement cost without introducing a plugin framework or committing to a GUI
toolkit now.

Before changing the baseline, record the evidence and tradeoffs here, update the
roadmap and contributor instructions, and replace the corresponding CI and
packaging checks together. Do not quietly add a second runtime.

## References

- [SDK language support][sdk-languages]
- [Public TypeScript client and event methods][sdk-client]
- [Official CLI compiler configuration][cli-types]
- [Official crypto compatibility patch][crypto-patch]
- [SDK maturity, authentication limits, and operational requirements][sdk-guidelines]
- [CLI runtime and account-module dependencies][cli-package]
- [Incubating account package][account-package]
- [GitHub CodeQL language support][codeql]
- [Dependabot ecosystem support][dependabot]

[sdk-languages]: https://github.com/ProtonDriveApps/sdk/blob/05c9115955589d9f6ab7392a36f8f0cb39327133/client/README.md
[sdk-client]: https://github.com/ProtonDriveApps/sdk/blob/05c9115955589d9f6ab7392a36f8f0cb39327133/client/js/src/protonDriveClient.ts
[cli-types]: https://github.com/ProtonDriveApps/sdk/blob/05c9115955589d9f6ab7392a36f8f0cb39327133/cli/tsconfig.json
[crypto-patch]: https://github.com/ProtonDriveApps/sdk/blob/05c9115955589d9f6ab7392a36f8f0cb39327133/config/js/patches/@protontech%252Fcrypto@2.2.0.patch
[sdk-guidelines]: https://github.com/ProtonDriveApps/sdk/blob/05c9115955589d9f6ab7392a36f8f0cb39327133/README.md
[cli-package]: https://github.com/ProtonDriveApps/sdk/blob/05c9115955589d9f6ab7392a36f8f0cb39327133/cli/package.json
[account-package]: https://github.com/ProtonDriveApps/sdk/blob/05c9115955589d9f6ab7392a36f8f0cb39327133/incubating/account/js/package.json
[codeql]: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning
[dependabot]: https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories
