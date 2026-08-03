# AgentEra application authentication

AgentEra Studio requires its own product session after the splash while keeping Hermes identity, private runtime state, and the recharge website independent.

## Product boundary

The private `bignormal/aera-cloud` service owns AgentEra APP users, identities, devices, personal spaces, sessions, and offline entitlements.

The existing Hermes account client remains a separate compatibility feature. The `agentera-claw-api` recharge site keeps separate users, cookies, tokens, balances, and identifiers; the desktop recharge action only opens its configured web page.

## Startup gate

The splash preflights Runtime and connection readiness without mounting user content, then restores a valid encrypted account session when one exists.

If no valid account session is available, the renderer stops at the account gate until the user explicitly completes browser sign-in.

An online session or valid signed offline entitlement selects the account-bound Runtime Profile before any runnable user screen opens. A newly authenticated device may install Runtime first, but must resolve its own physical Profile before main. Authentication never becomes a writer to [[agentera-self-evolution#AgentEra self-evolution compatibility#Local learning loop|Hermes local learning]].

### Account-required routing

An absent account session is not a runnable product state during internal testing.

[[src/renderer/src/App.tsx#App]] restores valid online or signed offline account access automatically across launches. An unauthenticated, expired, revoked, disabled, or secure-storage-blocked state remains on [[src/renderer/src/screens/AuthGate/AuthGate.tsx#AuthGate]]; only the explicit login action opens browser registration or sign-in. Runtime installation, Profile ownership resolution, chat, and the main layout cannot mount before signed account access.

Blocked account states remain on the recovery gate, and unavailable secure storage stays fail closed. The account gate preserves the local Hermes data directory but exposes no account portals, Cloud control-plane operations, workspaces, organizations, encrypted backup, official quality submission, or local chat.

#### Layout connection privacy

The layout mounts only for a signed account. A rejected account-mode check falls back to local presentation without an unhandled renderer rejection.

##### Account connection lookup fallback

An authenticated layout whose Remote/SSH mode lookup rejects presents local mode and absorbs the rejection, so a transient account-connection failure cannot become an unhandled renderer error.

#### Chat transport privacy

Unauthenticated state never initializes chat transport or reads and subscribes to account-owned Remote/SSH connection configuration.

### Guest Profile isolation

The installation-scoped guest owner remains an internal compatibility boundary for old local data and focused isolation tests, but the current product startup does not select it as a runnable session.

[[src/main/agentera-profile-binding.ts#createAgenteraGuestRuntimeOwner]] derives domain-separated guest owner identifiers from the protected installation identity. The binding store can still recognize guest-owned physical Profiles without opening, reassigning, copying, or merging them into a signed account.

The central IPC guard retains the narrow legacy policy for explicit bootstrap operations and an already bound guest Profile, but [[src/renderer/src/App.tsx#App]] does not route unauthenticated users into those handlers. Account and online channels require signed product access.

#### Profile discovery owner freshness

Local Profile discovery may await filesystem work while authentication or an account switch changes ownership, so ownership is resolved only after discovery returns and immediately before synchronous bind, activation, or creation.

[[src/main/agentera-profile-binding.ts#discoverProfilesForCurrentOwner]] returns discovered locations with the then-current validated owner. The local account-space IPC handler uses that pair without another asynchronous boundary, preventing a stale guest or account principal from binding the Profile.

### Sanitized preflight

[[src/main/agentera-startup-preflight.ts#runAgenteraStartupPreflight]] keeps pre-auth connection and installation checks inside the main process and returns only three allowlisted fields.

The result contains connection mode, an installation-derived post-auth target, and a soft verification warning. An absent Runtime targets bundled installation; every installed Runtime targets main regardless of model credentials. [[src/main/agentera-startup-preflight.ts#probeAgenteraInstallFiles]] checks approved file existence without opening Profile config, credentials, Memory, sessions, or learning state.

### IPC enforcement

[[src/main/ipc/auth-guard.ts#AGENTERA_IPC_CHANNEL_POLICY]] assigns every main-process IPC channel exactly one preflight, authenticated, or bound-Profile access level. [[src/main/ipc/auth-guard.ts#createGuardedIpcMain]] asserts that level before the original handler can read Runtime data.

The separate `window.agenteraRuntimeAccess` preload namespace returns only sanitized preflight and claim states. Other owners' IDs, local Profile paths, remote URLs, SSH configuration, credentials, and product secrets never appear in those types.

The separate `window.agenteraRuntimeDistribution` lifecycle namespace is authenticated rather than bound-Profile because it manages the product-owned executable capability layer, never Profile data. Its main-process handlers serialize an exact public state before every reply or event; archive locations, filesystem paths, signatures, keys, tokens, and ownership identifiers remain main-process-only.

### Renderer state machine

[[src/renderer/src/App.tsx#App]] applies the sanitized startup target only after signed account access and Runtime ownership checks.

#### Latest authentication event wins startup routing

If an authentication refresh event arrives while the sanitized startup preflight or splash delay is still pending, the renderer routes from that latest event instead of overwriting it with an older `getState` snapshot.

This closes the restored-session race without weakening fail-closed behavior: a newer blocked, revoked, disabled, expired, or unauthenticated event also takes precedence before any Runtime or Profile screen mounts.

The three-second branded splash remains unchanged. A missing Runtime proceeds to bundled installation only after account access. `main` additionally requires the current local Profile to match the signed account owner; remote and SSH contexts remain account-only. A legacy `setup` target is normalized to `main` after that ownership check.

[[src/renderer/src/screens/AuthGate/AuthGate.tsx#AuthGate]] is the explicit sign-in/recovery surface and presents the product-owned `src/renderer/src/assets/aila.glb` as Aila's native Three.js 3D character. While that asset loads, the surface shows only a neutral progress indicator and never substitutes a different avatar or flat “A” identity. It opens registration, sign-in, and recovery only in the system browser, never renders password, email, phone, verification-code, WebView, or local-bypass inputs, and explains fail-closed platform secure-storage errors.

Before the renderer can show any runnable screen, the authenticated local route resolves the account's own physical space in the main process. It keeps an already-active owned Profile, otherwise reactivates that account's earliest still-present binding. If the account has no binding, it binds an empty active Profile or creates a fresh non-cloned Profile beside meaningful unowned or foreign data. Returning accounts therefore reuse their original local space, while every new account proceeds automatically with a blank isolated space and never sees or inherits another account's Runtime data.

[[src/renderer/src/screens/ProfileClaim/ProfileClaim.tsx#ProfileClaim]] remains the fail-closed retry surface when ownership resolution itself fails, but normal local account login no longer asks the user to choose a space. Meaningful unbound legacy data remains untouched; fresh creation activates a separate physical Profile and continues directly to main without inheriting the previous Profile's model configuration.

The splash local-mode escape is retained, but its configuration mutation is queued until product authentication succeeds and then runs through the authenticated main-process `agentera-switch-to-local` channel. It cannot bypass the product gate.

## Browser sign-in

The user-facing path is one sign-in flow: the desktop opens the system browser, the user signs in or registers, and the one-use loopback callback returns automatically. No separate consent or "allow and return" step appears.

Every user-initiated desktop sign-in requests explicit account selection. The account gate's normal and restarted attempts, the unauthenticated sidebar action, and the switch-account action all send `forceAccountSelection: true`, which the main-process client serializes only as `prompt=select_account`. A persistent system-browser credential therefore cannot silently approve the previously used account after desktop sign-out or a renderer restart. The browser presents the ordinary sign-in form; the desktop does not promise that the service supplies a multi-account chooser.

Automatic startup restoration remains separate: a valid encrypted local product session resumes without opening the browser or requiring account selection. Desktop sign-out still clears the local product session and performs the existing device self-revocation only. It does not call the browser logout endpoint, clear system-browser cookies, or broaden sign-out to other web sessions.

The underlying transport still uses Authorization Code with PKCE. Only a two-minute authorization code and state return through `127.0.0.1`; access, refresh, and offline tokens never appear in the callback URL. Passwords and verification codes never enter the Electron renderer or main process.

Successful registration creates the browser session immediately and continues the same pending desktop sign-in request. The Cloud account center keeps a short browser session for active requests and a separate 30-day HttpOnly persistent credential for app relaunches. When the short session expires, the persistent credential restores account and desktop sign-in access; Cloud browser sign-out revokes both browser credentials.

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

Every account Runtime IPC edge rechecks the current trusted deadline before its handler can start new work.

The retained legacy guest edge still requires the explicit guest-capable policy level and installation-scoped guest Profile binding, but is not reachable from current product startup.

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

When no account session exists, the sidebar and main layout do not mount. The full-screen account gate does not probe account Profile data or open a browser until the user activates its explicit login control.

Switching accounts completes safe sign-out first and then opens browser authorization with explicit account selection. The UI warns that a pending offline revocation may temporarily count toward the five-device limit and that cloud account deletion cannot erase local Hermes data.

The Agent control plane applies the same switch at its own storage boundary. [[src/main/agentera-agent-control/db.ts#AGENTERA_CONTROL_PLANE_SCHEMA_VERSION]] schema v9 and [[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] prevent the next account from listing or reopening another personal space's drafts, cached versions, installation operations, RuntimeBindings, ConversationBoundaries, or pending sanitized records.

The cloud may transfer an installation to another AgentEra account only after the previous owner has revoked that device and the installation presents the identical public key. Active devices and changed keys remain owner-conflicted.

## Existing Profile migration

The first authenticated launch binds an empty account-specific Profile automatically.

If the active Profile already contains meaningful unowned or differently owned data, that data remains untouched and the current account owner receives a separate fresh Profile automatically. Later sign-in and account switches follow the same deterministic rule: the main process reactivates that owner’s existing bound Profile, or creates one isolated fresh Profile when the owner is new on the device. Signing out returns to the account gate instead of opening a guest workspace.

Binding never copies, uploads, or rewrites Memory, USER, skills, sessions, files, or Curator state. One physical Profile belongs to one AgentEra owner, consistent with [[agentera-self-evolution#AgentEra self-evolution compatibility#Runtime isolation|Runtime isolation]].

### Physical Profile ownership

[[src/main/agentera-profile-binding.ts#AgenteraProfileBindingStore]] stores encrypted, versioned ownership metadata under Electron `userData`, keyed by the canonical physical Profile path and a stable random Runtime Profile ID.

Fresh creation writes an encrypted V3 reservation containing only stable operation, owner, Profile, Runtime Profile, display-name, activation, and timestamp fields before invoking Hermes. A retry or cold restart reuses the exact reserved identities and existing safe scaffold; a foreign binding, immutable replay drift, or unexpected private marker remains fail-closed. Valid V1 and V2 binding arrays migrate to V3 only after complete decryption and validation.

Account-space resolution considers only still-present Profiles matching the exact tenant, user, and installation; it keeps the active match or deterministically selects the earliest binding. There is no ordinary unbind or reassignment operation.

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
