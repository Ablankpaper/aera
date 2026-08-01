# Agent ModelPolicy V2 and core bug closure plan

This plan closes the current Agent creation, publication, installation, shared-use, and model-catalog failures without weakening USER-owned Runtime isolation or reusing stale evidence.

## Fixed direction

- Agent creation does not require a configured model.
- New manifests use ModelPolicy V2 with `user_select`, `allowlist`, or `fixed` mode.
- V1 canonical bytes, signature verification, cache records, and installed behavior remain compatible.
- A concrete provider/model/credential route is selected by the current user at install or repair time.
- Every new conversation freezes the resolved route in its RuntimeBinding; existing conversations never change route.
- Provider endpoints, API keys, credential fingerprints, Profile paths, Memory, USER, sessions, files, and private Skills never enter shared Agent bytes or Cloud records.
- Organization shell context remains selected while personal Agent mutations remain explicitly USER-scoped.

## Evidence levels

Evidence must be reported separately as local targeted tests, repository gate, PR CI, merged-main CI, immutable candidate, manifest/deployment, and real service or device acceptance.

## TODO: contract and compatibility

- [x] Add Cloud `AgentManifestV2` and `AgentModelPolicyV2` schemas.
- [x] Define canonical policy rules: `user_select` has empty allowlists, `allowlist` has non-empty allowlists, and `fixed` has exactly one provider and model.
- [x] Keep V1 decoding and canonical JSON byte-for-byte unchanged.
- [x] Add V2 canonicalization, digest, signature, cache, policy-snapshot, and response parsing tests.
- [x] Sync the public Cloud and Internal Admin OpenAPI contracts before consumer implementation.
- [x] Regenerate Desktop and Admin types from the reviewed Cloud schemas.

## TODO: Desktop authoring and model catalog

- [x] Default new drafts to V2 `user_select` and make model configuration optional.
- [x] Preserve existing V1 drafts and published versions without silent conversion.
- [x] Remove global model-history merging from the draft editor.
- [x] Add explicit advanced `allowlist` and `fixed` authoring modes.
- [x] Show every selectable model as `model name · provider label`.
- [x] Invalidate selectors when a provider or model is deleted.
- [x] Keep publish enabled without a Runtime model; start-using requests a current live route.

## TODO: installation and runtime readiness

- [x] Resolve the current-owner model route at install or repair time.
- [x] Validate the route against the signed V1 constraints or V2 policy and effective Organization policy.
- [x] Seed only the resolved route and same-owner credential into a fresh `cloneFrom=null` Profile.
- [x] Freeze the canonical route in each new RuntimeBinding.
- [x] Separate published, installable, installed, ready, repair-required, and runtime-unavailable states.
- [x] Treat HTTP 200 with an empty SSE stream as a bounded runtime failure with a precise error code.
- [x] Use the main-process preparation path for every installed-Agent chat entry point; cross-surface real smoke remains a release gate.

## TODO: core Agent and model bugs

- [x] Retain the Organization-shell USER-Agent context regression test.
- [x] Split signature, digest, cache, published-content, policy, installation, and runtime error codes end to end.
- [ ] Prove personal publish and use with a real model response marker.
- [ ] Prove a second account can discover, install, select its own model, and use a shared Agent without sharing Runtime data.
- [x] Prove deleted models disappear from Agent and chat selectors without restarting the app in local tests.

## TODO: release gates

- [ ] Run failure-first targeted tests while implementation is unstable.
- [ ] Run each repository's complete gate once at its merge or candidate boundary.
- [ ] Require exact-head PR CI and merged-main CI.
- [ ] Bind candidate artifacts and images to immutable digests.
- [ ] Verify deployed digest and SHA before cross-service smoke.
- [ ] Run one two-account Agent smoke only after the deployed digest changes.
- [ ] Keep physical Windows acceptance for the immutable release artifact.

## Stop conditions

- A target worktree or candidate does not match the recorded SHA.
- A change would clone, upload, log, or share Runtime Profile private state or credentials.
- A signed V1 artifact would be reinterpreted or rewritten.
- Deployment identity cannot be proven.
- An operation would broaden public exposure or alter an unrelated healthy service.
