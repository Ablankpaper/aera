# Beta.27 Reliability Plan

Beta.27 is an approved Desktop implementation plan; this section records its intended boundaries without claiming that the product code, Electron gate, release, or updater rollout already exists.

## Owner model-route authority

Main will provide one owner-scoped catalog for [[provider-setup]], Agent installation, and installed-Agent chat so those surfaces cannot select different Profile sets.

The public selection is an opaque source Profile/model handle plus catalog revision. Canonical provider, endpoint, API mode, and credential availability are revalidated in Main, while credential references and values remain outside public catalog output.

## Recoverable model configuration

Provider/model edits will cross one typed Main mutation instead of several independent renderer calls, with dependency writes committed before activation and exact stage-aware outcomes.

The non-secret operation journal will live at Electron `userData/model-configuration/model-configuration.db`, outside the active Profile `state.db`. Short-lived exact sibling backups enable verified crash rollback; the journal contains only symbolic roles and digests, never keys, paths, or raw bodies.

## Organization submission isolation

One stale local draft reference will be quarantined per Cloud submission instead of failing the full [[agentera-organizations]] list.

The parent Agent control panel will own one list request, while the child panel becomes presentational. A confirmed Owner/Admin detach removes only the local link and preserves the Cloud submission, draft, Version, Installation, Profile, and Hermes state.

## Immutable Agent conversation segments

Installed-Agent model changes will keep one visible thread while creating immutable local segments in [[agentera-agent-control-plane]].

Each segment freezes one resolved route, RuntimeBinding, ConversationBoundary, and Hermes session. Activation occurs at the first output or tool event; a pre-output failure leaves the previous segment active, and a post-output failure is never replayed automatically.

## Acceptance and release boundary

The planned gate uses fresh Electron/Hermes roots, fixture Cloud state, and two loopback providers to cover save/restart, catalog consistency, A-to-B switching, policy modes, attachments, remote failure, and one Organization conflict.

Focused tests, build, and isolated Electron evidence remain separate from exact-head CI, merged-main CI, artifact publication, updater delivery, and physical internal-client acceptance.
