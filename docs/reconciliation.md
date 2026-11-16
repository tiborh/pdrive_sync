# Read-only reconciliation and dry runs

The `plan` command compares an explicitly selected local directory with an
existing My files subfolder in Proton Drive. **It does not apply its plan: no
uploads, local downloads, renames, or deletions are performed.** There is no
`--apply` flag or background synchronization service.

It does write private state, SDK caches, and diagnostics **outside** the selected
local tree. It reads remote file contents when needed for verification, as
described below. Keep the output and state private: both contain file metadata.

## Usage

Build the [qualified integration helper](proton-integration.md#build-and-offline-checks)
and authenticate its separate session first. From `integration/`:

```sh
./dist/pdrive-integration auth login
./dist/pdrive-integration plan \
  --local "$HOME/Dropbox" \
  --remote /my-files/Dropbox \
  --state "$HOME/.local/state/pdrive_sync/planner.sqlite"
```

Both roots must already exist. Nothing defaults to a real sync folder. The remote
root must be a My files subfolder, not the account root; use a dedicated folder.
The local root must be a real directory, not a symlink. Its canonical path,
filesystem identity, remote path, remote UID, and event scope are persisted and
must match on later invocations. A replaced or remounted local root can therefore
require explicit recovery rather than being mistaken for deleted files.

Use the **same planner state file** for subsequent runs. Do not reuse the older
`events` command's journal database. State must be a private, singly linked regular
file owned by you, outside the local root; symlink destinations are rejected.
Overlapping the helper's private data/cache/log directories is also rejected.
One process at a time may open a state file.

For machine-readable output:

```sh
./dist/pdrive-integration plan \
  --local "$HOME/Dropbox" \
  --remote /my-files/Dropbox \
  --state "$HOME/.local/state/pdrive_sync/planner.sqlite" \
  --format json
```

Text is the default. Filenames are quoted/escaped; every item has an explanation.
JSON output is one complete object with `schemaVersion: 1`, roots, update
statistics, summary counts, and plan items. No partial plan is printed on failure.
`./dist/pdrive-integration --help` also describes the command.

| Exit code | Meaning |
| --- | --- |
| `0` | Complete plan, without conflicts/review/unsupported entries; proposals are still unapplied |
| `2` | Complete plan contains conflicts, required review, or unsupported entries |
| `1` | Incomplete operation: authentication, access, scan, verification, state, or other error |

## What the plan means

| Action | Meaning |
| --- | --- |
| `unchanged` | Both directories exist, or file sizes and verified content digests match |
| `upload` / `download` | Proposed new copy or one-sided change since the matching baseline |
| `create-local-directory` / `create-remote-directory` | Proposed directory creation |
| `conflict` | Different files, concurrent changes, replaced identity, or a type collision |
| `review` | A previously matching entry is absent, or stable remote identity changed path |
| `unsupported` | Local symlink/special file, native Proton document, or missing revision |

A new one-sided file has no evidence of an earlier matching version, so it proposes
a copy. A missing **previously matching** file instead requires review: the planner
does not guess between deletion, restoration, and replacement. If both sides are
absent, that observation still does not acknowledge a deletion.

Conflicting, unsupported, or review-required parent paths suppress descendant
proposals. Resolving a parent may reveal more items on the next run. This avoids
proposing writes through a symlink or a file/directory collision.

## Content verification and bandwidth

Local regular files are streamed through SHA-1 on each run; timestamps alone never
establish equality. Hidden files, empty files/directories, nested paths, and UTF-8
names are included. Symlinks, including dangling links, are reported and not
intentionally followed. Non-UTF-8 filenames, unreadable directories, and detected
changes during scanning fail the entire plan rather than produce a partial tree.

The live study found that the official CLI's uploads expose SHA-1 metadata with
`sha1Verified: false`. We **do not silently trust those claimed hashes**:

- SDK-verified size/digest metadata can be used directly.
- Otherwise, the exact remote revision is streamed through the SDK's verified
  downloader into a hash sink. No plaintext content is saved to a local file.
- Download/signature failures and size/digest disagreements stop planning.
- The computed hash, byte count, and verification source are cached by remote
  UID/revision. Unchanged revisions and renames reuse that verification.

**The first run may read as much remote content as a full download of all
unverified files.** Later runs read changed/new unverified revisions. Streaming
does not retain whole files in application memory, but it still consumes network,
CPU, and SDK buffers. Output reports `verifiedFiles` and `verifiedBytes`; these
count plaintext bytes hashed, not total encrypted network traffic.

This is a synchronization comparison using Proton's SHA-1 convention, not a
replacement for backups or an adversarial collision-proof integrity system.

## Persistent state and event updates

On the first successful plan, the adapter obtains an event baseline, recursively
snapshots the selected remote tree, then consumes the change feed. Later runs use
that cached tree plus events, hydrating changed nodes without relisting existing
folders. Only a newly entering remote subtree is recursively listed.
`remoteUpdate.mode`, `events`, and `listedFolders` expose this behavior.
Local scanning remains a full read-only scan.

Events are consumed as a complete batch before metadata hydration. Snapshot
updates, the final cursor, and newly observed matching-content agreements commit
atomically in SQLite after the local scan and plan succeed. Interrupted scans,
downloads, or event batches cannot acknowledge partial work. Sibling events
sharing a cursor are not lost.

**Only content observed equal on both sides establishes or updates an agreement.**
A proposed upload/download never updates that baseline. For example, a local
change proposes an upload; if the remote file then changes too, the next dry run
reports a conflict rather than pretending the upload happened.

Tree refresh/removal, selected-root removal/trash, missing access, degraded
metadata, unsafe names, and ambiguous duplicate remote paths fail closed.
Refresh/removal blocks persist across restart. Keep the old state and recover
access; an explicitly chosen new state file bootstraps a new observation history.
That loses matching baselines and rereads the remote tree/content. It is not
automatic recovery and must not become routine recursive polling.

## Validation and remaining limits

The offline suite covers three-way comparisons, unapplied plans, unsupported
parents, local hashing, metadata errors, recursive event updates, interrupted
batches, content-verification caching/failures, state isolation, and missing roots.
The packaged helper also passed nine planner-specific live checks using synthetic
cloud fixtures:

1. Recursive matching/new/conflicting files were classified correctly.
2. Local contents/mtimes and remote metadata/revisions were unchanged by planning.
3. Restart reused state with no relisting or rereading unchanged revisions.
4. Text output explained conflicts and returned exit code `2`.
5. A local-only content change proposed an upload.
6. A later remote change remained a conflict because the upload was never applied.
7. A nested remote revision proposed a download without rescanning the tree.
8. A missing previously matching local file required review.
9. A newly entering folder listed only its subtree.

The live harness is opt-in and **does write synthetic fixtures**, unlike `plan`.
It verifies cleanup by moving its randomly named cloud folder to trash, never
permanently deleting it:

```sh
PDRIVE_ALLOW_LIVE_TESTS=1 bun scripts/validate-live.ts --planning-only
```

Omit `--planning-only` to include the earlier scheduler/crash integration checks.
Do not run live tests against real Dropbox files or real synchronization folders.

There is no atomic snapshot spanning both filesystems: concurrent edits can
invalidate a plan, even when scan consistency checks pass. No plan is an executable
authorization; future apply operations must revalidate inputs. Move/deletion
application, automatic refresh recovery, permissions/ownership/timestamp
preservation, local watchers, large-tree performance, account-wide concurrent
clients, and unattended keyring access remain later work.
