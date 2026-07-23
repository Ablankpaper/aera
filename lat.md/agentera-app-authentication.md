# AgentEra application authentication

AgentEra Studio requires its own product session after the splash while keeping Hermes identity, private runtime state, and the recharge website independent.

## Product boundary

The private `bignormal/aera-cloud` service owns AgentEra APP users, identities, devices, personal spaces, sessions, and offline entitlements.

The existing Hermes account client remains a separate compatibility feature. The `agentera-claw-api` recharge site keeps separate users, cookies, tokens, balances, and identifiers; the desktop recharge action only opens its configured web page.

## Startup gate

The splash may preflight Runtime and connection readiness without mounting user content, then every local, remote, SSH, and install path passes through the AgentEra product gate.

An online session or valid signed offline entitlement selects the bound Runtime Profile before any runnable user screen opens. A fresh authenticated device may install Runtime first, but must create and bind its empty Profile before main. Authentication never becomes a writer to [[agentera-self-evolution#AgentEra self-evolution compatibility#Local learning loop|Hermes local learning]].

### Sanitized preflight

[[src/main/agentera-startup-preflight.ts#runAgenteraStartupPreflight]] keeps pre-auth connection and installation checks inside the main process and returns only three allowlisted fields.

The result contains connection mode, an installation-derived post-auth target, and a soft verification warning. An absent Runtime targets bundled installation; every installed Runtime targets main regardless of model credentials. [[src/main/agentera-startup-preflight.ts#probeAgenteraInstallFiles]] checks approved file existence without opening Profile config, credentials, Memory, sessions, or learning state.

### IPC enforcement

[[src/main/ipc/auth-guard.ts#AGENTERA_IPC_CHANNEL_POLICY]] assigns every main-process IPC channel exactly one preflight, authenticated, or bound-Profile access level. [[src/main/ipc/auth-guard.ts#createGuardedIpcMain]] asserts that level before the original handler can read Runtime data.

The separate `window.agenteraRuntimeAccess` preload namespace returns only sanitized preflight and claim states. Other owners' IDs, local Profile paths, remote URLs, SSH configuration, credentials, and product secrets never appear in those types.

The separate `window.agenteraRuntimeDistribution` lifecycle namespace is authenticated rather than bound-Profile because it manages the product-owned executable capability layer, never Profile data. Its main-process handlers serialize an exact public state before every reply or event; archive locations, filesystem paths, signatures, keys, tokens, and ownership identifiers remain main-process-only.

### Renderer state machine

[[src/renderer/src/App.tsx#App]] applies the sanitized startup target only after product authentication and Runtime ownership checks.

The three-second branded splash remains unchanged. `welcome` is reachable only for an authenticated fresh installation; `main` additionally requires the current local Profile or remote/SSH connection context to match the signed-in owner. A legacy `setup` target is normalized to `main` after that ownership check.

[[src/renderer/src/screens/AuthGate/AuthGate.tsx#AuthGate]] opens registration, sign-in, and recovery only in the system browser. It never renders password, email, phone, verification-code, WebView, or local-bypass inputs, and it explains fail-closed platform secure-storage errors.

[[src/renderer/src/screens/ProfileClaim/ProfileClaim.tsx#ProfileClaim]] automatically binds an empty Profile, but meaningful existing data remains untouched until the user explicitly chooses to bind it in place or create a separate empty Profile. Fresh creation activates the new physical Profile and continues directly to main without inheriting the previous Profile's model configuration.

The splash local-mode escape is retained, but its configuration mutation is queued until product authentication succeeds and then runs through the authenticated main-process `agentera-switch-to-local` channel. It cannot bypass the product gate.

## Browser authorization

The system browser handles registration, login, recovery, identity binding, and device management through Authorization Code with PKCE and a one-use loopback callback.

Only a two-minute authorization code and state return through `127.0.0.1`; access, refresh, and offline tokens never appear in the callback URL. Passwords and verification codes never enter the Electron renderer or main process.

### Loopback callback

[[src/main/agentera-auth/pkce.ts#createAgenteraPkceAttempt]] creates fresh 256-bit state and verifier values for each attempt, while [[src/main/agentera-auth/loopback.ts#startAgenteraLoopbackListener]] binds only an ephemeral `127.0.0.1` port.

The listener accepts one canonical authorization code on the exact callback path, compares state in constant time, bounds the query, rejects other methods and paths, and returns a static page that contains no protocol value before closing on success, cancellation, error, or timeout.

### Cloud token exchange

[[src/main/agentera-auth/client.ts#AgenteraCloudClient]] builds the fixed authorization URL and sends authorization codes, PKCE verifiers, refresh tokens, and device proofs only in bounded same-Origin POST bodies.

The client signs the cloud protocol digest through the installation Ed25519 key, rejects redirects and unexpected response fields, maps only documented token fields, and never includes a token-bearing response body in an error.

### Main-process controller

[[src/main/agentera-auth/controller.ts#AgenteraAuthControllerImpl]] owns transient access tokens, browser-attempt lifecycle, encrypted session persistence, online refresh, logout, and the allowlisted state published to the renderer.

[[src/main/app/start.ts#startMainProcess]] creates one controller, restores the window after a valid callback, disposes the listener on quit, and routes the authorization URL through [[src/main/security.ts#isAllowedAgenteraAuthExternalUrl]]. The policy allows only the configured cloud Origin and exact OAuth request shape.

[[src/preload/index.ts]] exposes the separate `window.agenteraAuth` namespace. Its seven methods carry only [[src/shared/agentera-auth.ts#AgenteraAuthPublicState]], login-control options, and an allowlisted portal target; AgentEra tokens, device keys, codes, verifiers, and encrypted blobs have no preload field.

## Desktop authentication foundation

The desktop foundation keeps product authentication in the main process and exposes only an allowlisted public state to the renderer and startup gate.

### Cloud origin boundary

[[src/main/agentera-auth/config.ts#parseAgenteraCloudOrigin]] accepts trusted HTTPS and loopback development HTTP only, requires an exact credential-free Origin, and refuses the separately configured recharge-site Origin.

[[src/main/agentera-auth/config.ts#agenteraCloudUrl]] rejects absolute and host-relative paths that could escape that Origin. Runtime configuration precedes build-time configuration, and no production domain or server IP is hard-coded. Runtime redirection cannot add entitlement trust: only `MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON` baked by the reviewed build may add a release issuer or public key.

### App-level secure store

[[src/main/agentera-auth/store.ts#AgenteraAuthStore]] keeps installation identity, product session, and pending self-revocation in one atomically replaced versioned file rooted by Electron `app.getPath("userData")` through [[src/main/agentera-auth/store.ts#createAgenteraAuthStoreForApp]].

Refresh tokens, offline entitlements, device private keys, and pending self-revocations are protected with the platform secure-storage adapter. Unavailable encryption fails closed; logout clears product session material without reading or modifying a Hermes Profile.

Secure-store boundary tests construct expected descendants through Node path APIs, so the same user-data isolation invariant is verified with native separators on macOS, Windows, and Linux.

[[src/shared/agentera-auth.ts#serializeAgenteraAuthPublicState]] rebuilds the renderer-visible state from an explicit allowlist, so extra token-, key-, code-, verifier-, or encrypted-blob fields cannot cross IPC by object spreading.

### Installation device identity

[[src/main/agentera-auth/device-key.ts#getOrCreateAgenteraDeviceIdentity]] creates one installation-scoped Ed25519 key pair, stores its private key only through the app-level encrypted store, and reuses the same identity after logout.

[[src/main/agentera-auth/device-key.ts#signAgenteraDeviceDigest]] signs only SHA-256-sized protocol digests. The bundled development root remains issuer-scoped to `http://127.0.0.1:8086`. [[src/main/agentera-auth/config.ts#parseAgenteraOfflinePublicKeysBuildConfig]] accepts release roots only from strict build-time JSON containing one canonical HTTPS IP issuer and canonical 32-byte Ed25519 public keys with unique stable IDs. The baked Cloud Origin must equal that sole issuer.

## Sessions and offline use

Access tokens last fifteen minutes in main-process memory, rotating refresh tokens last thirty days in platform secure storage, and device-bound signed offline entitlements roll for seven days after successful validation.

A valid offline entitlement allows local use and native Hermes learning when the configured model endpoint remains reachable. Cloud functions pause, and expiry gates new work without deleting local state.

### Signed entitlement validation

Offline access accepts only an exact cloud-issued Ed25519 entitlement bound to the current user, device, installation, personal space, issuer, audience, policy, issue time, and seven-day expiry.

[[src/main/agentera-auth/entitlement.ts#verifyAgenteraOfflineEntitlement]] rejects unknown keys, extra or malformed claims, non-canonical encodings, altered signatures, copied-device credentials, future issue times, and expired credentials. [[src/main/agentera-auth/config.ts#getBundledAgenteraOfflinePublicKeys]] selects trust roots only for their approved issuer. The controller validates issuer, key ID, signature, user/device/installation/space binding, and expiry before persisting any product session.

### Trusted time and rolling validation

Online state renews every fifteen minutes, while a control-plane outage retries with bounded exponential backoff and jitter without treating model-endpoint availability as cloud authorization.

[[src/main/agentera-auth/time-anchor.ts#AgenteraTrustedTimeAnchor]] combines the last trusted server time with monotonic elapsed time and requires online validation after a material wall-clock rollback. [[src/main/agentera-auth/lifecycle.ts#AgenteraAuthLifecycle]] owns the single refresh timer and recovery schedule.

The controller serializes refreshes so a rotating Refresh Token is never replayed and rejects a late response after logout or account switching. Every successful response must contain a newly verified entitlement before any replacement session is persisted.

### Runtime edge enforcement

Every authenticated Runtime IPC edge rechecks the current trusted deadline before its handler can start new work.

[[src/main/ipc/auth-guard.ts#createProductAccessGuard]] calls the controller's synchronous entitlement assertion before Profile ownership checks. Expiry, rollback, revocation, account disablement, or deletion publishes a blocked state; the existing owner-switch coordinator then aborts active runs and closes Gateway, SSH, dashboard, and SQLite state without editing Hermes files.

## Device and account lifecycle

Each account has at most five active devices and receives one personal space during the registration transaction.

Password recovery revokes all sessions. Sign-out clears product credentials but retains local data. Self-service deletion immediately suspends the account, starts a seven-day cooling period, and never erases local Hermes data automatically.

### Safe sign-out and pending revocation

Sign-out blocks local product access immediately, then revokes the current cloud device before clearing the encrypted session when the control plane is reachable.

[[src/main/agentera-auth/lifecycle.ts#createPendingAgenteraSelfRevocation]] signs an installation-bound, nonce-protected self-revocation digest that contains no bearer token. If delivery fails, the store atomically keeps only that encrypted intent after clearing the session, retries with a fresh timestamp, and treats replay or an already-absent device as complete.

Logout, revocation, and retry never delete, move, upload, hash for upload, or unbind Memory, USER, sessions, files, skills, Curator state, or any other Hermes learning asset.

### Account and recharge controls

The sidebar account menu and Settings account pane expose only online/offline status, truncated identifiers, expiry, and allowlisted actions.

[[src/renderer/src/components/AgenteraAccountMenu.tsx#AgenteraAccountMenu]] and [[src/renderer/src/components/settings/AgenteraAccountPane.tsx#AgenteraAccountPane]] open account and device management on the configured cloud Origin. Recharge opens the separately configured URL validated by [[src/main/agentera-auth/config.ts#parseAgenteraRechargePublicUrl]] and shares no AgentEra APP credential.

Switching accounts completes safe sign-out first and then opens browser authorization with explicit account selection. The UI warns that a pending offline revocation may temporarily count toward the five-device limit and that cloud account deletion cannot erase local Hermes data.

The Agent control plane applies the same switch at its own storage boundary. [[src/main/agentera-agent-control/db.ts#AGENTERA_CONTROL_PLANE_SCHEMA_VERSION]] schema v2 and [[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] prevent the next account from listing or reopening another personal space's drafts, cached versions, installations, RuntimeBindings, or pending sanitized records.

The cloud may transfer an installation to another AgentEra account only after the previous owner has revoked that device and the installation presents the identical public key. Active devices and changed keys remain owner-conflicted.

## Existing Profile migration

The first authenticated launch binds an empty Profile automatically or asks whether an existing learned Profile should be bound in place or left untouched while a new isolated Profile is created.

Binding never copies, uploads, or rewrites Memory, USER, skills, sessions, files, or Curator state. One physical Profile belongs to one AgentEra owner, consistent with [[agentera-self-evolution#AgentEra self-evolution compatibility#Runtime isolation|Runtime isolation]].

### Physical Profile ownership

[[src/main/agentera-profile-binding.ts#AgenteraProfileBindingStore]] stores encrypted, versioned ownership metadata under Electron `userData`, keyed by the canonical physical Profile path and a stable random Runtime Profile ID. There is no ordinary unbind or reassignment operation.

[[src/main/agentera-profile-binding.ts#hasMeaningfulHermesProfileData]] uses only approved filenames, file types, sizes, and directory entry presence. Existing data is bound in place, while fresh creation always calls the Hermes Profile API with `cloneFrom` set to `null` and refuses unexpectedly copied private markers.

### Connection context ownership

[[src/main/config.ts#getConnectionConfig]] persists a stable opaque `connectionContextId`; remote URL, API-key, SSH identity, or Remote OAuth credential changes rotate it. [[src/main/agentera-connection-owner.ts#AgenteraConnectionOwnerStore]] encrypts only the context-to-owner binding and never stores the URL, SSH fields, or credentials.

[[src/main/agentera-connection-owner.ts#createAgenteraOwnerSwitchCoordinator]] makes account changes tear down active runs, the cached SQLite connection, local Gateway execution, dashboards, and SSH transport before another owner can claim a Runtime context.

## Cloud service shape

The first service is a Go modular monolith with an embedded React/Vite account center, a dedicated PostgreSQL database and role, and a dedicated Redis credential and namespace.

It may share physical infrastructure with other sites but shares no business database, account system, signing key, encryption key, cookie, or public Origin. The first release uses one application container and no public admin console.

## Sensitive data

Passwords use Argon2id, while normalized email and phone values use AES-256-GCM ciphertext plus an independently keyed HMAC lookup index.

Authorization codes, verification codes, and refresh tokens are stored only as hashes. Signing and encryption keys are separate, versioned, injected outside Git, and recoverable through encrypted operational backups.

## Release boundary

Authentication is delivered before Agent configuration/version sync, but this ordering does not enable cloud ownership of Hermes adaptive state.

### Cross-repository verification

The desktop pins the reviewed cloud OpenAPI document, generates deterministic TypeScript, and rejects stale output or sibling-contract drift before authentication code can pass its release gate.

`scripts/generate-agentera-cloud-types.mjs` derives the contract hash and formatted types, while `scripts/check-agentera-cloud-contract.mjs` validates critical endpoints, exact fields, documented errors, and the strict loopback redirect shape. The desktop client consumes those generated request and response types without permissive casts.

Because the contract hash is byte-based, `.gitattributes` forces the pinned OpenAPI document and generated TypeScript to LF on every checkout. The contract regression suite verifies these Git attributes and gives deterministic generation enough time on slower CI runners. The reviewed contract includes the owner-scoped policy snapshot read needed to verify a manually selected Agent version before local activation.

[[tests/e2e/agentera-auth.e2e.ts]] exercises the real browser, cloud, and Electron lifecycle only against isolated services and a synthetic Hermes boundary fixture. Hashes prove authentication never modifies the fixture, and the same suite can target the unpacked macOS application.

Desktop CI compiles, type-checks, tests, and validates the contract on macOS, Windows, and Linux. CI success is not a substitute for physical Windows/Linux secure-storage, firewall, loopback-return, install, update, and uninstall evidence.

Agent sync, client-side encrypted backup, workspace/organization scopes, and official Agent evolution pipelines remain later independently designed projects. Every authentication release remains blocked by the Hermes compatibility gate.

The loopback development key proves local integration only. A Beta build cannot grant offline access until its reviewed workflow bakes the matching public key and exact HTTPS IP issuer into the main-process bundle. Malformed JSON, unknown fields, duplicate IDs, remote HTTP, issuer paths, DNS issuers, non-canonical encodings, wrong Ed25519 lengths, and a differing Cloud Origin all fail the build. Setting the similarly named runtime environment variable cannot expand trust, and private signing material never enters this repository.
