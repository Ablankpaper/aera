# Durable Agent Version Cache Recovery Design

## Goal

Make the verified local `AgentVersion` cache converge automatically after a filesystem or SQLite interruption without weakening signature, digest, path-containment, account-isolation, or read-only enforcement.

## Scope

This change is limited to the Desktop version cache and its publication/IPC/UI error boundary. It does not change Cloud publication, Runtime Seed, Installation/Profile binding, update policy, release version, or any private Hermes state.

The cache remains split across two durable representations:

- immutable verified files below the current account's Aera-owned version directory;
- one account-scoped `cached_agent_versions` SQLite row containing the signed version JSON and cache-relative path.

Neither representation is accepted blindly. Every recovered version is parsed, canonicalized, signature-checked, digest-checked, owner-scoped, path-contained, and re-read from read-only files before use.

## Recovery invariants

The coordinator enforces these invariants:

1. A version ID can resolve to only one content digest for one tenant/owner tuple.
2. A valid SQLite row with a missing or unusable directory is sufficient to rebuild the immutable directory because the row contains the complete signed version JSON.
3. One valid immutable directory with no SQLite row is sufficient to recreate the row after the directory is reverified.
4. A verified destination is retained when the later SQLite transaction fails. The next retry or cold-start read completes the missing row instead of requiring cache deletion.
5. Only cache-owned `.staging-<uuid>` trees are removed automatically. Arbitrary sibling paths are never followed or deleted.
6. A rename loser treats `EEXIST` or `ENOTEMPTY` as a concurrency signal, removes only its own staging tree, verifies the winning destination, and converges through the SQLite idempotency check.
7. Multiple digest directories for one version ID, a row/directory digest disagreement, or unverifiable stored bytes fail closed as a cache conflict or corruption.
8. No raw filesystem path, SQLite message, credential, signed payload, or private owner identifier crosses IPC or is stored as a publication summary.

## Coordinator flow

### Fresh verified publication

`cacheVerifiedVersion` first verifies the Cloud version with the existing trust store and canonical digest logic. It then reconciles the account/version root:

1. read and validate any existing row;
2. remove only recognized stale staging trees;
3. reject any different digest directory or row;
4. adopt an already valid matching destination, or write a new staging tree;
5. fsync, make files and directory read-only, and atomically rename;
6. reverify the final directory;
7. insert the SQLite row in `BEGIN IMMEDIATE` and commit.

If step 7 fails, the verified directory remains. The transaction is rolled back and the caller receives a stable database failure. A later call adopts the directory and retries only the local row insertion; it never republishes or re-executes the Cloud mutation.

### Cold read with a row only

`getVerifiedVersion` validates and re-verifies the signed JSON stored in the row. If the referenced directory is absent or recoverably invalid, it writes a new immutable directory from that verified JSON, re-reads it, and returns it. Policy snapshot JSON remains in the existing row.

### Cold read with a directory only

When no row exists, `getVerifiedVersion` scans only the exact current account/version directory. Exactly one read-only digest-named directory must pass the complete trust and canonical-content checks. The coordinator inserts the missing row and re-reads through the normal row path. Zero candidates is `cache_not_found`; multiple candidates is `cache_conflict`.

### Existing corrupt destination with a fresh verified candidate

When `cacheVerifiedVersion` has a freshly verified Cloud candidate and its exact destination is corrupt, the coordinator removes only that cache-owned destination and rebuilds it. Without a fresh candidate or a valid row, corruption remains fail-closed.

## Concurrency

The filesystem rename and SQLite uniqueness constraints are the two serialization points. No process-local mutex is relied upon for correctness.

- The first writer to rename wins the immutable directory.
- Other writers verify that winner rather than overwrite it.
- `BEGIN IMMEDIATE` plus the row primary key serializes row adoption.
- A writer that observes an existing row revalidates its digest and signed JSON before treating the operation as idempotent.

This supports retry, re-entry after an Electron crash, and two Desktop processes racing on the same isolated test root without creating a second semantic version.

## Stable failure codes

The cache maps platform errors into bounded codes:

- `cache_filesystem_denied`: `EACCES`, `EPERM`, or a read-only filesystem denial;
- `cache_filesystem_failed`: other bounded filesystem failures such as I/O or space exhaustion;
- `cache_database_failed`: `ERR_SQLITE_*` or `SQLITE_*` failures, including a failed commit;
- `cache_conflict`: `EEXIST`/`ENOTEMPTY` that cannot converge, multiple digests, or row/directory disagreement;
- `cache_corrupt`: invalid stored JSON, signature, digest, layout, or bytes;
- `cache_permissions_invalid`: mutable cached content violates the immutable-cache contract;
- `cache_recovery_failed`: a recognized interrupted state cannot be brought back to a verified postcondition.

Publication translates those codes to equally bounded `publication_cache_*` IPC codes. The renderer receives only the code and localized guidance. Draft failure records keep the lower-level stable code and a fixed summary, never an exception message or path.

## Tests

Failure-first tests cover:

- valid directory with no row, recovered after a new cache instance simulates cold restart;
- valid row with the directory removed, rebuilt and reverified;
- recognized stale staging cleanup;
- verified rename followed by a deferred SQLite commit failure, followed by successful retry;
- `EACCES`, `EPERM`, `EEXIST`, and representative `ERR_SQLITE_*` mapping;
- a rename race in which a second cache instance wins;
- conflicting digest directories and corrupt stored bytes remaining fail-closed;
- exact publisher, IPC, and localized UI error-code propagation.

The existing trust, owner-isolation, policy-snapshot, publication, typecheck, build, and LAT gates remain required.

## Non-goals

This work does not add a general saga framework, background worker, cache-clearing command, user-visible path, Cloud retry, Runtime process coordinator, or Beta.23 version bump. Those belong to separate reviewed changes.
