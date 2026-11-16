# Explicit one-shot synchronization

`sync --apply` transfers unambiguous new files and one-sided content changes
between explicitly selected roots. **This remains an experimental personal-use
tool, not a backup or an unattended sync client.** Test with disposable folders
first. Do not run Dropbox or another writer against either root during apply.

Conflicts are **left untouched and reported**; independent safe operations can
still proceed. Missing previously agreed files, moves, symlinks, special files,
and native Proton documents require review. There is no deletion propagation,
automatic conflict winner, or background service.

## Usage

Build and authenticate the [integration helper](proton-integration.md), and create
both test roots first. From `integration/`:

```sh
./dist/pdrive-integration plan \
  --local "$HOME/pdrive-test" \
  --remote /my-files/pdrive-test \
  --state "$HOME/.local/state/pdrive_sync/sync.sqlite"

./dist/pdrive-integration sync --apply \
  --local "$HOME/pdrive-test" \
  --remote /my-files/pdrive-test \
  --state "$HOME/.local/state/pdrive_sync/sync.sqlite" \
  --format json
```

Use the **same state file for plan and apply**, and keep it for subsequent runs.
Existing planner databases are accepted; the diagnostic `events` journal is not.
The [root binding and state privacy rules](reconciliation.md#usage) still apply.
Apply recomputes a fresh plan while holding the state lock; saved JSON is not an
executable plan. Omitting `--apply` fails before authentication or state creation.
`plan --apply` is rejected.

Text output is the default. JSON is one `schemaVersion: 1` object with roots,
`deletionPropagation: false`, result counts, per-path results, and pending intents.
Each result explains `completed`, `unchanged`, `skipped`, `failed`, `review`, or
`recovered` status and includes its recovery directory when available. Preflight
and other whole-command errors use stderr rather than success-shaped JSON.

| Exit code | Meaning |
| --- | --- |
| `0` | No failed, skipped, review-required, or pending work |
| `2` | Conflicts, unsupported/missing entries, or interrupted work need review |
| `1` | At least one transfer failed, or the command could not safely complete |

This is not an all-or-nothing transaction: a nonzero exit can follow successful
independent transfers. A later run does not retransmit acknowledged equal content.

## Transfer safety

Operations run serially, with directories before children. Inputs and parent
identities are checked against this run's plan, with fresh event-fed remote
metadata before transfers. Unsupported or unresolved parents block descendants.

Uploads stream from a private local snapshot with the SDK's expected size/hash
checks. New names must not collide. Existing remote files receive a revision,
not delete-and-recreate replacement. The helper checks uncached revision history
before and after replacement, including retention of the previous revision, and
verifies the resulting UID, active revision, size, and content digest.

Downloads use the SDK's verified exact-revision stream, check size/hash, and stage
bytes before publication. Local directory descriptors and no-follow opens prevent
a substituted parent symlink from redirecting writes. Existing destination bytes
are moved into the private recovery directory; the staged file is then linked
into place exclusively, without overwriting a newly appearing path. A failed
replacement attempts exclusive restoration and reports restoration failures.
Files and affected directories are synchronized before acknowledgement.

**Recovery staging and download destinations must be on the same filesystem.**
Nested mount points can therefore cause individual downloads to fail. The
implementation currently requires Linux `/proc/self/fd`. New local files use mode
`0600`, directories `0700`; preservation of original permissions, ownership,
timestamps, ACLs, extended attributes, and hardlink topology is not promised.

The [remote content-verification policy](reconciliation.md#content-verification-and-bandwidth)
also applies: untrusted metadata is verified by reading remote bytes. Apply may
read those bytes again to stage an actual download.

## Recovery and disk usage

Before a canonical mutation, the helper durably records an intent in SQLite and
an `operation.json` manifest under **`STATE.files/transfer-*`**, outside the local
root. State, manifests, paths, and recovery contents are private account data.

On restart, both sides matching the intended target can acknowledge an interrupted
transfer without uploading again. Definitely unchanged preconditions permit a
retry. Other states remain blocked for review; a pending parent also blocks its
children. `plan` reports pending intents but does not resolve them or acknowledge
their apparent equality.

**There is no general force/resolve or automatic crash-rollback command yet.**
A crash after moving an old destination but before installing its replacement
can require manual exclusive restoration. Stop all writers, preserve the state
and recovery directory, and inspect the manifest and both versions before making
any manual changes. Do not delete the database to make a pending error disappear.
Re-run `plan` and then explicit apply after recovery; persistent ambiguity remains
a review item rather than authorizing an overwrite.

Successful transfers also retain their artifacts. `original`, when present,
contains the previous local destination; `incoming` holds staged/uploaded bytes.
An installed download and its `incoming` stage can be hardlinks to the same inode:
the latter is **not an independent immutable backup**.

There is **no automatic pruning or disk quota**. Retained snapshots can consume
substantial space, including uploads and new downloads. Clean only individually
identified, no-longer-needed completed operation directories, with the helper
stopped, after checking pending intents and preserving any desired backups.
Never remove recovery files belonging to unresolved work.

## Concurrency limits

**Keep both roots quiescent during apply, including other Proton clients.**
The SDK offers no atomic expected-active-revision compare-and-swap for uploads.
Pre/post checks detect many races but cannot guarantee another client's update
will not race publication. A racing upload can change the active revision before
the helper reports failure; retained Proton revisions are not a permanent backup.
There is also no atomic snapshot or transaction spanning local files and Proton.

The exclusive state lock coordinates only processes using that database, not
another database or another application. Detected races preserve recovery
evidence and report errors, but general multi-writer, low-disk, power-loss,
account-limit, and large-tree hardening remain later milestones.

## Validation

The credential-free suite covers transfers, repeat runs, revision retention,
original local recovery copies, conflicts, unsupported types, signature errors,
source edits, collisions, lost completion responses, retries, concurrent remote
revisions, and parent symlink substitution.

Opt-in packaged-executable checks use randomly named synthetic cloud fixtures:

```sh
PDRIVE_ALLOW_LIVE_TESTS=1 bun scripts/validate-live.ts --sync-only
```

These qualify explicit apply gating, nested/empty/Unicode and binary transfers,
no-op reruns, stable-identity revision updates, staged local replacement/recovery,
conflict preservation, and disabled deletion propagation. Cleanup verifies the
cloud fixture in trash, without permanent deletion. Reports and local synthetic
payloads remain private under `.local/validation/`; this does not exercise a real
Dropbox directory or qualify unattended operation.
