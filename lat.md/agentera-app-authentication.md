# AgentEra application authentication

AgentEra Studio requires its own product session after the splash while keeping Hermes identity, private runtime state, and the recharge website independent.

## Product boundary

The private `bignormal/aera-cloud` service owns AgentEra APP users, identities, devices, personal spaces, sessions, and offline entitlements.

The existing Hermes account client remains a separate compatibility feature. The `agentera-claw-api` recharge site keeps separate users, cookies, tokens, balances, and identifiers; the desktop recharge action only opens its configured web page.

## Startup gate

The splash may preflight Runtime and connection readiness without mounting user content, then every local, remote, SSH, setup, and install path passes through the AgentEra product gate.

An online session or valid signed offline entitlement selects the bound Runtime Profile before any runnable user screen opens. A fresh authenticated device may install Runtime first, but must create and bind its empty Profile before setup or main. Authentication never becomes a writer to [[agentera-self-evolution#AgentEra self-evolution compatibility#Local learning loop|Hermes local learning]].

## Browser authorization

The system browser handles registration, login, recovery, identity binding, and device management through Authorization Code with PKCE and a one-use loopback callback.

Only a two-minute authorization code and state return through `127.0.0.1`; access, refresh, and offline tokens never appear in the callback URL. Passwords and verification codes never enter the Electron renderer or main process.

## Sessions and offline use

Access tokens last fifteen minutes in main-process memory, rotating refresh tokens last thirty days in platform secure storage, and device-bound signed offline entitlements roll for seven days after successful validation.

A valid offline entitlement allows local use and native Hermes learning when the configured model endpoint remains reachable. Cloud functions pause, and expiry gates new work without deleting local state.

## Device and account lifecycle

Each account has at most five active devices and receives one personal space during the registration transaction.

Password recovery revokes all sessions. Sign-out clears product credentials but retains local data. Self-service deletion immediately suspends the account, starts a seven-day cooling period, and never erases local Hermes data automatically.

## Existing Profile migration

The first authenticated launch binds an empty Profile automatically or asks whether an existing learned Profile should be bound in place or left untouched while a new isolated Profile is created.

Binding never copies, uploads, or rewrites Memory, USER, skills, sessions, files, or Curator state. One physical Profile belongs to one AgentEra owner, consistent with [[agentera-self-evolution#AgentEra self-evolution compatibility#Runtime isolation|Runtime isolation]].

## Cloud service shape

The first service is a Go modular monolith with an embedded React/Vite account center, a dedicated PostgreSQL database and role, and a dedicated Redis credential and namespace.

It may share physical infrastructure with other sites but shares no business database, account system, signing key, encryption key, cookie, or public Origin. The first release uses one application container and no public admin console.

## Sensitive data

Passwords use Argon2id, while normalized email and phone values use AES-256-GCM ciphertext plus an independently keyed HMAC lookup index.

Authorization codes, verification codes, and refresh tokens are stored only as hashes. Signing and encryption keys are separate, versioned, injected outside Git, and recoverable through encrypted operational backups.

## Release boundary

Authentication is delivered before Agent configuration/version sync, but this ordering does not enable cloud ownership of Hermes adaptive state.

Agent sync, client-side encrypted backup, workspace/organization scopes, and official Agent evolution pipelines remain later independently designed projects. Every authentication release remains blocked by the Hermes compatibility gate.
