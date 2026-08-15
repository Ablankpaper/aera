# Beta.29 Model Recovery Self-Heal

This design repairs false model-configuration recovery locks inherited from Beta.28 while preserving fail-closed handling for genuinely mixed or unverifiable configuration state.

## Scope

The change is owned by Aera Desktop and is limited to local model-configuration transactions. It fixes rollback route verification, cold-start reconciliation of existing `recovery_required` journal rows, bounded diagnostics, and regression coverage.

It does not delete the model-configuration database, clear all application data, rewrite credentials, relax Profile ownership, alter Cloud contracts, or treat a mixed configuration as healthy. It does not change provider-selection policy or introduce network recovery.

## Evidence and root cause

The captured macOS Beta.29 client contains operation `0f1267a9-aa1c-417c-9506-385df872b08c`, created under the earlier client on 2026-08-13 and left in `recovery_required`. The current `.env`, `providers.json`, `models.json`, and `config.yaml` exactly match that operation's `before` digests and not its attempted `after` digests. Their modification times follow the reverse restore order, showing that the disk rollback completed.

`getModelConfig()` caches the active model configuration for five seconds. Transaction rollback reads the attempted active route, restores snapshot bytes through `restoreModelConfigurationFiles()`, and immediately reads the active route again. The raw restore path does not invalidate the model-config cache, so the second read can return the attempted route even though the old bytes are back on disk. The coordinator then misclassifies a successful rollback as `recovery_required`.

Beta.29 fixed the earlier custom-Provider identity regression but did not change the cache/restore boundary. On later startup, `recoverIncompleteOperations()` short-circuits any row already marked `recovery_required`, adds a permanent Profile lock, and never re-evaluates the now-restored files. Reinstalling the app preserves this journal under Electron user data, so the lock survives application replacement.

The capture omitted the journal's old/new route values and current `model-definitions.json` digest. The persisted-lock cause is confirmed; the exact first verification comparison that initiated the 2026-08-13 rollback remains a bounded historical unknown.

## Approaches considered

### Delete or reset the journal

Deleting `model-configuration.db` would unblock this user but would discard evidence and could authorize writes over a genuinely mixed configuration. This is rejected.

### Wait for cache expiry before verification

Sleeping for five seconds would hide the immediate symptom while retaining timing-dependent correctness and slowing every rollback. This is rejected.

### Fresh transactional reads plus deterministic reconciliation

The selected approach makes transaction correctness independent of presentation caches and re-evaluates terminal recovery rows from complete disk evidence. Exact known states self-heal; ambiguous states remain fail-closed.

## Architecture

### Fresh active-route boundary

Model-configuration verification and recovery require an active-route read that cannot return the five-second `mc:<profile>` cache. The config module will expose a narrow invalidation or fresh-read boundary rather than making the generic cache public.

The mutation adapter will provide a fresh route read for transaction verification. After any raw snapshot restore, the coordinator will invalidate the target Profile's model-config cache before comparing the restored route. Cold recovery will also use fresh route reads before classifying current bytes.

Ordinary UI reads retain the existing cache. Credential caches and unrelated configuration caches are unchanged.

### Existing recovery-row reconciliation

`recoverIncompleteOperations()` will no longer treat `recovery_required` as permanently terminal without inspection. For every incomplete row it first validates the owner handle, Profile ID, Profile ownership, journal manifest, and the five allowlisted file paths.

It then reads all five current digests and the active route without cache:

1. Current digests equal complete `after` digests and the active route equals `newRouteKey`: finish `committed`, remove backups safely, and clear the lock.
2. Current digests equal `before` digests and the active route equals `oldRouteKey`: finish `rolled_back`, remove backups safely, and clear the lock. This path does not require backups because the target product state is already exactly verified.
3. Otherwise, reconstruct the snapshot and attempt the existing exact backup restore. Invalidate the route cache, then require all five `before` digests and `oldRouteKey` before finishing `rolled_back`.
4. Any invalid owner, foreign Profile, incomplete digest set, mixed bytes, missing/tampered backup, unreadable route, journal error, or post-restore mismatch remains `recovery_required` and locked.

The order intentionally recognizes an already-restored state before requiring old backup files. This lets affected Beta.29 users self-heal even when a prior process removed or failed to inventory sibling backups, without guessing from partial evidence.

### Failure semantics and observability

Mutation results remain fail-closed and backward compatible. A reconciled row becomes an existing terminal state (`committed` or `rolled_back`); an ambiguous row continues to return `model_configuration_recovery_required`.

The implementation may log only operation ID, bounded stage/state, and a bounded reconciliation outcome. It must not log owner handles, Profile paths, route keys, digests, file bodies, environment values, or credentials. Renderer wording is outside this focused repair unless a new bounded result is required.

## Data flow

```text
startup or rollback
  -> validate journal owner/Profile and five-file manifest
  -> invalidate model-config cache
  -> read five file digests + active route from disk
  -> exact after/new: committed
  -> exact before/old: rolled_back
  -> otherwise verify backups and restore
  -> invalidate cache and verify exact before/old
  -> mismatch or error: recovery_required
```

## Test design

Implementation follows failure-first TDD.

1. Prime the attempted active route in cache, restore the old `config.yaml`, and prove immediate rollback finishes `rolled_back` without waiting five seconds.
2. Start with a `recovery_required` row whose five current digests and active route equal `before`/old; cold recovery must finish `rolled_back` without reading backups.
3. Start with a `recovery_required` row whose complete current state equals `after`/new; cold recovery must finish `committed`.
4. Keep a `recovery_required` row locked for mixed digests, route mismatch, invalid ownership, missing/tampered backup, or restore mismatch.
5. Preserve existing recovery of nonterminal prepared/stage rows and existing committed-recognition behavior.
6. Add an isolated runtime-level regression so the test exercises the real `getModelConfig()` cache and raw file restore boundary rather than only a mocked route adapter.

Focused coordinator, operation-store, runtime, and config tests must pass. The full Vitest suite, type checks, production build, `git diff --check`, and `lat check` are required before handoff. A packaged macOS upgrade from an isolated Beta.28-style journal is a release-acceptance gate, not a substitute for the unit/integration tests.

## Success criteria

- A successful file rollback cannot become `recovery_required` solely because an attempted route remains in the five-second cache.
- An existing exact `before`/old Beta.28 recovery row self-heals on the next fixed-client startup without deleting user data.
- An exact `after`/new row is recognized as committed.
- Mixed or unverifiable state remains locked and preserves recovery evidence.
- No secret, route identity, digest, owner handle, or local path crosses the existing diagnostic/privacy boundary.
- Existing model save, cold recovery, Provider identity, and unrelated Desktop tests do not regress.

## Delivery boundary

Implementation targets `aera/beta29-model-recovery-self-heal` from `origin/main` at Beta.29 commit `e558ca0a`. A passing branch does not itself constitute a merge, release, updater publication, or physical-client acceptance. Version naming and signed macOS artifact publication remain separate release decisions.
