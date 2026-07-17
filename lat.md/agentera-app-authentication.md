# AgentEra application authentication

AgentEra Studio requires its own product session after the splash while keeping Hermes identity, private runtime state, and the recharge website independent.

## Product boundary

The private `bignormal/aera-cloud` service owns AgentEra APP users, identities, devices, personal spaces, sessions, and offline entitlements.

The existing Hermes account client remains a separate compatibility feature. The `agentera-claw-api` recharge site keeps separate users, cookies, tokens, balances, and identifiers; the desktop recharge action only opens its configured web page.

## Startup gate

The splash may preflight Runtime and connection readiness without mounting user content, then every local, remote, SSH, setup, and install path passes through the AgentEra product gate.

An online session or valid signed offline entitlement selects the bound Runtime Profile before any runnable user screen opens. A fresh authenticated device may install Runtime first, but must create and bind its empty Profile before setup or main. Authentication never becomes a writer to [[agentera-self-evolution#AgentEra self-evolution compatibility#Local learning loop|Hermes local learning]].

### Sanitized preflight

[[src/main/agentera-startup-preflight.ts#runAgenteraStartupPreflight]] keeps pre-auth connection and installation checks inside the main process and returns only three allowlisted fields.

The result contains connection mode, the saved post-auth target, and a soft verification warning. [[src/main/agentera-startup-preflight.ts#probeAgenteraInstallFiles]] checks approved file existence without opening Profile config, credentials, Memory, sessions, or learning state.

### IPC enforcement

[[src/main/ipc/auth-guard.ts#AGENTERA_IPC_CHANNEL_POLICY]] assigns every main-process IPC channel exactly one preflight, authenticated, or bound-Profile access level. [[src/main/ipc/auth-guard.ts#createGuardedIpcMain]] asserts that level before the original handler can read Runtime data.

The separate `window.agenteraRuntimeAccess` preload namespace returns only sanitized preflight and claim states. Other owners' IDs, local Profile paths, remote URLs, SSH configuration, credentials, and product secrets never appear in those types.

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

[[src/preload/index.ts]] exposes the separate `window.agenteraAuth` namespace. Its six methods carry only [[src/shared/agentera-auth.ts#AgenteraAuthPublicState]] and login-control options; AgentEra tokens, device keys, codes, verifiers, and encrypted blobs have no preload field.

## Desktop authentication foundation

The desktop foundation keeps product authentication in the main process and exposes only an allowlisted public state before browser authorization is wired into startup.

### Cloud origin boundary

[[src/main/agentera-auth/config.ts#parseAgenteraCloudOrigin]] accepts trusted HTTPS and loopback development HTTP only, requires an exact credential-free Origin, and refuses the separately configured recharge-site Origin.

[[src/main/agentera-auth/config.ts#agenteraCloudUrl]] rejects absolute and host-relative paths that could escape that Origin. Runtime configuration precedes build-time configuration, and no production domain or server IP is hard-coded.

### App-level secure store

[[src/main/agentera-auth/store.ts#AgenteraAuthStore]] keeps installation identity, product session, and pending self-revocation in one atomically replaced versioned file rooted by Electron `app.getPath("userData")` through [[src/main/agentera-auth/store.ts#createAgenteraAuthStoreForApp]].

Refresh tokens, offline entitlements, device private keys, and pending self-revocations are protected with the platform secure-storage adapter. Unavailable encryption fails closed; logout clears product session material without reading or modifying a Hermes Profile.

[[src/shared/agentera-auth.ts#serializeAgenteraAuthPublicState]] rebuilds the renderer-visible state from an explicit allowlist, so extra token-, key-, code-, verifier-, or encrypted-blob fields cannot cross IPC by object spreading.

### Installation device identity

[[src/main/agentera-auth/device-key.ts#getOrCreateAgenteraDeviceIdentity]] creates one installation-scoped Ed25519 key pair, stores its private key only through the app-level encrypted store, and reuses the same identity after logout.

[[src/main/agentera-auth/device-key.ts#signAgenteraDeviceDigest]] signs only SHA-256-sized protocol digests. Development signing keys are not desktop trust roots; the bundled offline verification-key map remains fail-closed until a reviewed release adds approved public key IDs.

## Sessions and offline use

Access tokens last fifteen minutes in main-process memory, rotating refresh tokens last thirty days in platform secure storage, and device-bound signed offline entitlements roll for seven days after successful validation.

A valid offline entitlement allows local use and native Hermes learning when the configured model endpoint remains reachable. Cloud functions pause, and expiry gates new work without deleting local state.

## Device and account lifecycle

Each account has at most five active devices and receives one personal space during the registration transaction.

Password recovery revokes all sessions. Sign-out clears product credentials but retains local data. Self-service deletion immediately suspends the account, starts a seven-day cooling period, and never erases local Hermes data automatically.

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

Agent sync, client-side encrypted backup, workspace/organization scopes, and official Agent evolution pipelines remain later independently designed projects. Every authentication release remains blocked by the Hermes compatibility gate.
