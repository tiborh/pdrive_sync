# Roadmap

This is a safety-first, stop-gap project, not a commitment to reproduce every
Dropbox feature. Milestones describe acceptance criteria rather than delivery
dates. The project should yield to Proton's official Linux implementation once
it is ready to use.

The [language-selection study](docs/language-selection.md) records the qualified
TypeScript/Bun baseline, validation evidence, and reasons to revisit the choice.

- [x] **Validate the building blocks and establish the project.**
  Complete isolated capability validation, record the findings and limitations,
  and establish the public repository, MIT license, and unofficial stop-gap scope.
- [x] **Resolve supported Proton integration.**
  Establish event-driven remote change detection without frequent recursive tree
  scans. Clarify application identification when wrapping the official CLI and
  select a CLI-only or SDK-backed integration. Qualify authentication, resumable
  live events, and packaging against the provisional language/runtime decision.
  Completed with an SDK-backed helper, isolated browser/keyring authentication,
  live event and restart checks, and a packaged Linux executable. See the
  [qualification and limitations](docs/proton-integration.md): exported event
  interfaces are used, but the pinned account host remains incubating and this
  is not Proton-endorsed production integration.
- [ ] **Deliver read-only reconciliation and dry-run output.**
  Add a CLI, explicit local/remote root configuration, a tested metadata adapter,
  persistent synchronization state, and an explainable plan of proposed changes.
  Keep this milestone non-destructive. Extend the existing formatting, linting,
  type checking, and offline CI tests to cover reconciliation.
- [ ] **Implement explicit, one-shot file synchronization.**
  Transfer only changed content, preserve conflicting versions, stage downloads
  before replacing files, and report individual failures accurately. Reject or
  clearly report unsupported file types. Keep deletion propagation disabled by
  default and require an explicit command to apply changes.
- [ ] **Handle moves and deletions conservatively.**
  Track stable remote identities, retain recoverable local copies, use remote
  trash, and detect ambiguous restores. Guard against missing roots, incomplete
  scans, and mass deletion. Treat uncertainty as an error, not proof of deletion.
- [ ] **Add unattended Linux operation.**
  Combine local filesystem notifications with the supported remote event
  integration, bounded concurrency, and backoff. Provide a systemd user service,
  status reporting, pause/resume, and clear authentication/keyring diagnostics.
- [ ] **Harden for dependable personal use.**
  Test crashes, offline recovery, partial batches, concurrent writers, low disk
  space, account limits, and larger trees. Document supported metadata and filename
  behavior, installation, upgrades, backup expectations, and remaining risks.
- [ ] **Optionally add a tray interface and an official-client migration path.**
  Reuse the CLI/service engine for status, notifications, and pause/resume rather
  than introducing a second sync engine. Document a safe handover when Proton's
  official implementation becomes suitable.

## Development guardrails

- CI must run without Proton credentials or access to anyone's real sync folder.
- Live integration checks must be opt-in and use synthetic, disposable fixtures.
- Conflicting or uncertain changes must not silently overwrite or delete data.
- Proton's current service terms and integration requirements apply throughout.
- Keep tooling proportional to the code that exists; add application checks as
  the corresponding implementation lands.
