# Legacy Model Config Migration

Beta.27 introduced a unified model configuration format that requires `model:` to be a mapping with structured fields. Legacy configs used a scalar format that causes duplicate key errors during saves.

When users upgrade from pre-Beta.27 versions, their `config.yaml` may contain:

```yaml
model: gpt-4
```

Beta.27's [[src/main/config.ts#upsertBlockChild]] function only recognizes mapping blocks (multi-line `key:\n  child: value` structures). When it encounters the legacy scalar `model: gpt-4`, it doesn't match the pattern and appends a second `model:` block with the new mapping format:

```yaml
model: gpt-4
model:
  provider: "custom:petoi"
  default: "gpt-4"
  base_url: "https://api.petoi.cn/v1"
```

YAML parsers reject duplicate top-level keys with `Map keys must be unique`, causing [[src/main/model-configuration-coordinator.ts]] to fail at the `native_route` stage and return:

```typescript
{
  status: "rejected",
  stage: "native_route",
  code: "model_save_native_route_failed",
  rollback: "restored"
}
```

The user sees: "模型服务未保存,系统没有保留任何部分配置。"

## Why Only Old Services Fail

New services start with canonical config while old services accumulate duplicate keys on first edit that only fail on subsequent operations.

- **New services**: Start with empty or already-canonical config → no duplicate keys
- **Old services on first edit**: The scalar `model:` remains, a mapping `model:` is appended → duplicate keys created but not immediately detected (no validation after first write)
- **Old services on subsequent edits**: Transaction reads the corrupted config → YAML parse fails → rollback

## The Fix

[[src/main/config-model-migration.ts#migrateModelConfigFormat]] runs before every write to `config.yaml`:

1. **Parse as YAML Document**: Use `yaml.parseDocument()` to preserve structure and detect duplicate keys
2. **Find all top-level `model` keys**: Collect scalar values and mapping nodes
3. **Remove duplicates**: Delete every top-level `model:` node but one, preferring a mapping over a scalar
4. **Re-parse the cleaned text**: Duplicate removal is a textual edit, so its output is parsed again before anything else trusts it
5. **Merge into one canonical mapping**:
   - If only a scalar survives: convert to `model:\n  default: <value>`
   - Preserve other fields (`provider`, `base_url`, `api_mode`, `context_length`)
6. **Preserve other blocks**: `providers:`, `auxiliary:`, `api_server:` remain untouched
7. **Validate before returning**: The result is run through `validateModelConfiguration`; if it still fails, the migration throws `code: "model_config_migration_unrepairable"` instead of returning half-repaired content

Step 7 is the contract callers depend on: a returned `MigrationResult` is always committable. Two legacy scalars used to survive step 3 as a scalar, so the next write appended a mapping beside it and re-created the duplicate; steps 4 and 7 close that.

This migration is called from:
- [[src/main/config.ts#setModelConfig]] — before every model activation
- [[src/main/native-custom-provider.ts#upsertNativeCustomProvider]] — before every custom provider write

## Commit Guard: Final YAML Validation

The migration normalizes config before write, but every write path can't be trusted to fully normalize a legacy layout. As a final safeguard, the transaction **verifies** the config it just committed and rolls back if it's still structurally invalid.

[[src/main/config-model-migration.ts#validateModelConfiguration]] rejects (throws `code: "model_config_validation_failed"`) a config that:
- does not parse as valid YAML,
- has a `providers:` that is not a mapping, or
- has more than one top-level `model:` key (a leftover scalar next to a mapping).

It is called from the upsert adapter's `verify` in [[src/main/model-configuration-runtime.ts]], after the activation stage wrote the profile's `config.yaml`. The coordinator treats a `false` from `verify` like any failed stage, so `rollbackLocalMutation` restores the snapshot and the user sees a rejection instead of a silently committed corrupted config. This closes the gap where a config that was already corrupt *before* the edit — and thus not touched by migration — could otherwise be committed as-is.

Position in the transaction (see [[src/main/model-configuration-coordinator.ts]]):
`COMMIT_STAGES` → `verify` (route existence + active route + `validateModelConfiguration`) → committed; any failure → rollback + `rejected`.

## Test Coverage

[[tests/legacy-model-config-save.test.ts]] verifies:

### Should migrate legacy scalar model to mapping format
Given config with `model: old-gpt-3.5`, migration produces `model:\n  default: old-gpt-3.5` and preserves `providers:` block.

### Should remove duplicate model: keys
Given config with both scalar and mapping `model:` keys, migration keeps only one mapping format with all fields intact.

### Should preserve nested model keys in other blocks
`auxiliary:\n  research:\n    model: "research-model"` is not touched — only top-level `model:` is migrated.

### Should not modify already-migrated config
Canonical `model:\n  provider: ...\n  default: ...` config returns unchanged with `modified: false`.

### Should handle empty config
Empty string input returns empty output without errors.

### Should handle config with only other blocks
Config with `providers:` and `auxiliary:` but no `model:` returns unchanged.

### Should handle malformed duplicate keys without crashing
Config with multiple scalar `model:` entries is cleaned to exactly one mapping.

## End-to-end save recovery

The unit tests above prove the migration helper works in isolation. These drive the real writers against an isolated `HERMES_HOME`, so they reproduce the user-visible Beta.27 save failure rather than a proxy for it.

Isolation pattern: set `process.env.HERMES_HOME` **before** `vi.resetModules()`, then dynamically `await import()` the module. `HERMES_HOME` is resolved at module load, so `vi.stubEnv` cannot redirect a config write path.

### Edits a legacy scalar config without duplicating the key
`setModelConfig` on a config holding `model: old-model` leaves exactly one top-level `model:`, in mapping form, carrying the new route — and leaves the unrelated `providers:` block in place.

### Repairs an already-duplicated config on the next save
`upsertNativeCustomProvider` against a config that already has both a scalar and a mapping `model:` — the call that used to throw `Map keys must be unique` — succeeds, returns `custom:petoi`, and collapses the file to one `model:` key.

### Adds a second model to a legacy service
Adding `["old-model", "new-model"]` to a legacy scalar service keeps both models and still writes exactly one top-level `model:` key.

### Leaves a canonical config byte-identical
An unrelated provider upsert against a canonical config preserves `default: "gpt-4"`, the user's `# comment`, and the nested `auxiliary.research.model` — a nested `model:` is never mistaken for the top-level target.

### Named profiles stay isolated
`setModelConfig(..., "installed")` migrates the named profile's `config.yaml` and leaves the default profile's file byte-identical, so a write can never land in the wrong profile.

### Rejects unsalvageable YAML before writing
When the existing config cannot be parsed at all, the writer throws and the file on disk is byte-identical afterwards: a rejected save never leaves a partial write.

### Keeps API keys out of config.yaml
After a provider upsert, `config.yaml` holds `key_env:` (the env-var reference) and no `sk-`-prefixed secret. The credential itself stays in the profile `.env`.

## Duplicate scalar recovery

The first repair only recognised `scalar + mapping`. Two legacy scalars kept the first scalar, so the next write appended a mapping and the file was corrupt again. These drive the real writer, because only the writer proves the shape is gone.

Covered by [[tests/legacy-model-config-duplicate-scalar.test.ts]].

### Collapses two legacy scalars through a real save
`model: first` beside `model: second` then a real `setModelConfig` leaves exactly one top-level `model:`, in mapping form, with `providers:` intact — the shape that previously re-corrupted on write.

### Collapses a scalar beside a mapping through a real save
A legacy scalar above a `custom:petoi` mapping survives a real `setModelConfig` to a different provider with one `model:` key and the provider's `api:` line untouched.

### Refuses a duplicate key beside an illegal providers block
When removing the duplicate still leaves `providers:` a scalar, `setModelConfig` throws and `config.yaml` is byte-identical afterwards.

### Reports the migration as unrepairable rather than returning partial content
`migrateModelConfigFormat` on that same shape throws `code: "model_config_migration_unrepairable"` carrying `problem: "providers_not_mapping"`, so callers cannot mistake it for a successful repair.

### Always returns content it would accept
For every repairable shape — two scalars, scalar + mapping, three mixed keys, valueless key + scalar — the returned content passes `validateModelConfiguration` and holds at most one top-level `model:`.

## Config health repair

Write-path migration only fires when something writes. A config already corrupted by an earlier build is never written to again — the save fails first — so the damage needs its own surface. [[src/main/config-health.ts#checkModelConfigStructure]] reports it and offers an in-place repair.

[[src/main/config-model-migration.ts#inspectModelConfigStructure]] classifies the file, and each shape gets its own code: `MODEL_CONFIG_DUPLICATE_KEY` for duplicated top-level `model:`, `MODEL_CONFIG_UNPARSEABLE` for a syntax error, `MODEL_CONFIG_PROVIDERS_NOT_MAPPING` for a malformed `providers:` block. Only the first has a mechanical repair; collapsing all three into one code told users to merge `model:` keys that were never duplicated.

`autoFixable` is set only when `migrateModelConfigFormat` can actually produce a file that then passes validation — anything else is reported without a Fix action or a fix description, because it needs a human. [[src/main/config-health.ts#fixModelConfigDuplicateKey]] re-inspects the file, refuses any non-duplicate shape, and re-validates the repaired content before writing, so a failed repair leaves the original in place.

Covered by [[tests/config-health-model-duplicate-key.test.ts]].

### Reports a duplicated model key as an auto-fixable error
A config with both scalar and mapping `model:` yields a `MODEL_CONFIG_DUPLICATE_KEY` issue with `severity: "error"` and `autoFixable: true`, and its `detail` never contains a credential value.

### Repairs the file in place
`autoFixIssue("MODEL_CONFIG_DUPLICATE_KEY")` collapses the file to one `model:` mapping while keeping `providers:` and `key_env:`, and a re-scan reports the issue resolved.

### Reports invalid YAML under its own code
Unparseable YAML yields `MODEL_CONFIG_UNPARSEABLE` with `autoFixable: false`, no `fixDescription`, no "merge" advice in its detail, and no duplicate-key issue alongside it.

### Reports a non-mapping providers block under its own code
`providers: invalid` yields `MODEL_CONFIG_PROVIDERS_NOT_MAPPING`, not a duplicate-key issue, and offers no merge suggestion.

### Refuses to auto-fix a non-duplicate problem
`autoFixIssue("MODEL_CONFIG_DUPLICATE_KEY")` on a non-duplicate structural error returns `ok: false` and leaves the file exactly as the user wrote it.

### Stays silent on a healthy config
A canonical config with a nested `auxiliary.research.model` produces no issue.

## Stale catalog retry policy

A save can also be rejected for a stale `expectedCatalogRevision` when the model library or a provider changed underneath an open Model Center. That rejection is safe to replay exactly once; most others are not. [[src/shared/model-configuration.ts#isSafeToRetryStaleRevision]] draws that line.

Three conditions must all hold. An explicit `reason: "stale_catalog_revision"`, which the coordinator sets at exactly one place — the revision comparison — and never for another refusal. The `validation` stage, which runs before any adapter work. And `rollback: "not_needed"`, proving nothing was written, so a replay cannot double-apply.

The stage/rollback pair alone is not enough: an unowned profile, illegal parameters, a delete with no legal replacement, and a moved active route all reject at `validation` with `not_needed` too, and replaying any of them fails again identically. The explicit reason is what separates the one fixable rejection from the rest.

`ModelCenter.tsx`'s `mutateWithRevisionRetry` consults this, re-reads the catalog, and replays at most once — so a genuine validation failure surfaces instead of looping.

Covered by [[src/shared/model-configuration.test.ts]], [[src/main/model-configuration-coordinator.test.ts]] and [[src/renderer/src/screens/Providers/ModelCenter.test.tsx]].

### Retries a pre-write validation rejection
A `validation` rejection carrying `reason: "stale_catalog_revision"` and `rollback: "not_needed"` is retryable; the same rejection without the reason is not.

### Withholds the retry reason from every other refusal
An unowned profile, illegal parameters, a delete with no replacement, and a moved active route each reject at `validation` with `not_needed` and **no** `reason`, so `isSafeToRetryStaleRevision` returns false for all four.

### Refreshes and retries once
A stale-revision rejection makes Model Center re-read the owner catalog and re-issue the save with the fresh revision, and the second attempt's result is what the user sees.

### Never retries an unrelated validation rejection
A `validation` rejection without the stale-revision reason is surfaced immediately: exactly one mutation call, no catalog refresh, and the error reaches the user.

### Never retries a stage that already wrote
Every write stage (`credential`, `provider`, `model_library`, `native_route`, `activation`) is non-retryable regardless of rollback outcome, as is a `validation` rejection that did roll back a write.

### Never retries a committed save
`committed` and `committed_refresh_warning` are never replayed.

## Profile target cache

Model Center reads the owner catalog once and reuses it for the revision and the write target. Nothing tied that cache to the profile it came from, so after a profile switch a save could carry the previous profile's revision and target.

The cache is now keyed by the profile that requested it, and every fetch carries a monotonic generation. A `profile` prop change clears the catalog and the write-target ref before anything can read them; `requireOwnerCatalog()` refetches rather than returning a catalog belonging to a different profile; and a response from a superseded generation is discarded instead of overwriting the current profile's state.

Covered by [[src/renderer/src/screens/Providers/ModelCenter.test.tsx]].

### Drops a previous profile's catalog on switch
After a rerender with a new `profile`, a save issued while the new catalog is still unavailable does not send the old profile's `expectedCatalogRevision` or `requestedProfileId`.

### Ignores a late response from a previous profile
A catalog request from the old profile that resolves after the switch neither replaces the new profile's catalog nor leaves the write target pointing at the profile the user left.

## Related

Related work: the transaction coordinator and the native provider writer.

- [[src/main/model-configuration-coordinator.ts]]: Transaction coordinator that calls `native_route` stage
- [[src/main/native-custom-provider.ts#configDocument]]: Reads and writes native provider config
- [[beta27-reliability-plan]]: Approved Beta.27 reliability boundaries
