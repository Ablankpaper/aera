# Cloud agent sync

Syncs desktop profiles (the app's agents) with the signed-in [[hermes-account-login|Hermes One account]]'s cloud agents, bidirectionally, via the backend's `/api/agents` CRUD.

The transitional sync covers color, persona (`SOUL.md` ↔ `systemPrompt`), and config basics (`model`/`provider` only). Private `MEMORY.md` and `USER.md` never enter cloud reconciliation. Skills, automations, and sessions are deferred; deletions never propagate.

## Sync engine

[[src/main/agent-sync.ts#syncAgents]] runs one single-flight pass: link local profiles to cloud agents, reconcile each part, create missing counterparts on both sides, and unlink mappings whose cloud agent disappeared.

The stored link (a profile's cloud `agentId`) is also read by [[wallet-token-balances#Wallet Sync]] via [[src/main/agent-sync.ts#getLinkedAgentId]], so backend-provisioned wallets can be fetched for the same agent.

Requests are bearer-authenticated with the device-login token — the account is located app-wide by [[src/main/account-store.ts#findAccountProfile]] (the token is saved under whichever profile was active at sign-in). Linking keys on the cloud agent's stable `id`; names only match never-synced profiles to their cloud namesakes and are never used to rename.

Links are **account-scoped**: every state write records the owning backend user id, and a pass skips (never unlinks, never pushes) profiles whose link belongs to a different account — signing out and back in as someone else must not re-upload the first account's agents to the second. A missing cloud agent only unlinks when the state provably belongs to the current account; legacy states without an owner are adopted when their agent exists in the account's list and skipped with a warning otherwise. Wallet flows apply the same rule through [[src/main/agent-sync.ts#getLinkedAgentAccountId]] — see [[wallet-token-balances#Wallet Sync]].

Per part, the pure [[src/main/agent-sync.ts#decidePartAction]] compares the last-sync base hash with both sides' current hashes: only one side moved → that side wins; both moved (or first sync) → last-writer-wins by timestamp (local file mtime vs the agent's `updatedAt`). Equal content is always a no-op.

Pushes are built by [[src/main/agent-sync.ts#buildPushBody]], which enforces the persona limit by _skipping_ oversize content with a warning. An unset local model is also skipped so a PATCH cannot clobber the cloud value with an empty string. Pulls use [[src/main/soul.ts#writeSoul]], [[src/main/profile-meta.ts#setProfileColor]], and [[src/main/config.ts#setModelConfig]] while preserving the local base URL.

A profile's stable **id** (its directory slug), not its editable display **name**, keys `getModelConfig`, `readSoul`, `cloud-sync.json`, and all pull writes, so a renamed profile keeps syncing against the same directory. The display `name` is used only as the cloud agent's human label.

Cloud-only agents are materialized locally by [[src/main/profiles.ts#createProfile]], which derives a valid, collision-free id from the cloud agent's display name. Only persona, color, and model/provider are written under that id; remote Memory is ignored.

## State file

Each linked profile stores its mapping in `cloud-sync.json`: cloud `agentId`, owning account user id, cloud-side name, and hashes for the three supported parts.

A successful pass discards obsolete legacy `base.memory` hashes without reading or writing Memory.

Parts that failed to push (or were skipped as oversize) keep their old base, so they stay pending rather than being silently marked clean. Deleting the file unlinks the profile — which is exactly what a pass does when the cloud agent was deleted in the console, leaving the local profile untouched.

## IPC and UI

The main process exposes `agent-sync-run`, `agent-sync-status`, and `agent-sync-linked-id` in [[src/main/ipc/register.ts#registerIpcHandlers]], next to the account handlers; a completed run also emits `agent-sync-updated` so the renderer can refresh.

`agent-sync-linked-id` returns the cloud agent id a profile is linked to (or null) — for the per-profile Sync tab below.

The preload bridge surfaces these as `syncAgents`, `getAgentSyncStatus`, `getLinkedAgentId`, and `onAgentSyncUpdated` on `window.hermesAPI`, typed by the shared shapes in [[src/shared/agent-sync.ts]].

[[src/renderer/src/screens/Agents/Agents.tsx]] (local mode only — Layout shows a remote notice otherwise) renders the sync affordance in the header: a signed-out hint pointing at the Providers account card, or a Sync button with the last pass's summary (warnings in the tooltip). It auto-runs one pass per visit when signed in, and reloads the profile list when a pass pull-created profiles. [[src/renderer/src/components/HermesAccountModal.tsx]] kicks off the first sync right after a successful sign-in.

The profile modal's **Sync** tab, [[src/renderer/src/components/profile/ProfileSyncPane.tsx]], is a per-profile manual path for when the auto-sync hasn't run: it shows the signed-in account, whether this profile is linked to a cloud agent (`getLinkedAgentId`), and this profile's outcome from the last pass, with a **Sync now** button that runs the same app-wide `syncAgents()`. Sign-in/unauthorized/error states are surfaced inline.

## Tests

[[src/main/agent-sync.test.ts]] fakes the profile/config/fs surface and stubs `fetch`, so the tests exercise the reconciliation logic itself; one account-lookup test lives in [[src/main/account-store.test.ts]].

### Locates the account app-wide

`findAccountProfile` finds a session saved under a named profile and prefers the default home when both have one, so sync works no matter which profile was active at sign-in.

### Part decision matrix

`decidePartAction` across the base/local/remote hash matrix: equal content is a no-op, a single moved side pushes or pulls, and both-moved / never-synced parts fall back to last-writer-wins by timestamp.

### Push bodies stay within limits

`buildPushBody` maps the supported parts to exactly the backend fields and skips an oversize persona or unset model instead of truncating or sending empty strings.

### Never syncs private Memory

Local `MEMORY.md` content never appears in POST or PATCH bodies, remote `memory` fields never write to disk, and legacy `base.memory` hashes are discarded without changing the Memory file.

### Keys on-disk work off the stable id

A renamed profile (id `hello-agent`, display name `Hello Agent`) drives all on-disk sync — state file, part reads — off the id, while the cloud agent it creates carries the display name as its label.

### Backs up new local profiles

A never-synced local profile is POSTed with persona, color, and model/provider only; the returned agent id is persisted to `cloud-sync.json`.

### Links by name and pulls the newer side

An unmapped profile links to its cloud namesake without creating a duplicate, and on first sync the newer side (the cloud, when local files are older) wins part by part.

### Pull-creates cloud-only agents

A cloud agent with no local counterpart becomes a local profile through `createProfile`; persona, color, and model/provider are written under its derived id while Memory remains untouched.

### Unlinks deleted cloud agents

When a mapped cloud agent disappears **and the link's recorded owner is the current account**, the pass removes `cloud-sync.json` and keeps the local profile — no DELETE is ever sent in either direction.

### Skips foreign-linked profiles

A profile whose state names a different `accountId` is left completely untouched — state file intact, nothing pushed or pulled — and wallet sync refuses it client-side with `status: "foreign"` before any backend call.

### Leaves ambiguous legacy links alone

A legacy state (no `accountId`) whose agent isn't in the current account's list is skipped with a warning, not unlinked.

It could be a console deletion or another account's agent — and a wrong unlink would re-upload someone else's agent on the next pass, so skipping is the safe read.

### Records the owning account

Every successful pass stamps the current account's user id into the state file, adopting legacy links whose agent exists in this account's list.
