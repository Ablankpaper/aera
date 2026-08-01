# AgentEra APP Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan in the main session, one checkpoint at a time. Do not delegate work to subagents unless the user explicitly changes the main-session instruction.

**Goal:** Deliver an AgentEra-only cloud account service and a post-splash desktop authentication gate with browser PKCE login, five-device enforcement, rolling seven-day offline access, personal-space ownership, and non-destructive local Hermes Profile binding.

**Architecture:** Build `bignormal/aera-cloud` as a private Go modular monolith that serves a React/Vite account center and versioned JSON API over one origin, with PostgreSQL as the source of truth and Redis for expiring challenges, leases, and rate limits. Integrate it into AgentEra Studio through a main-process-only authentication subsystem, a loopback OAuth callback, platform secure storage, a renderer-safe public session view, and an ownership sidecar that never reads or changes Hermes content. Keep the recharge gateway, Hermes Account, Remote Dashboard OAuth, and AgentEra Runtime internals as separate security domains.

**Tech Stack:** Go 1.26, `net/http`, Chi, pgx/v5, go-redis/v9, PostgreSQL 17, Redis 7.4, Argon2id, AES-256-GCM, HMAC-SHA-256, Ed25519, React 19, Vite 7, TypeScript 5.9, Electron 39, Vitest, Playwright, Docker Compose, GitHub Actions.

---

## Execution boundaries

Use these repository roots throughout the plan:

```bash
export DESKTOP=/Users/zizimutou/Desktop/aera/aera
export CLOUD=/Users/zizimutou/Desktop/aera/aera-cloud
export RUNTIME=/Users/zizimutou/Desktop/aera/aera-runtime
```

Repository ownership remains explicit: `$DESKTOP` is `bignormal/aera`, `$CLOUD` is the private `bignormal/aera-cloud`, and `$RUNTIME` is `bignormal/aera-runtime`. `/Users/zizimutou/Desktop/aera/agentera-claw-api` (`bignormal/agentera-claw-api`) remains the independent recharge/model-relay product and is not modified by this plan.

The following rules are release blockers, not implementation preferences:

1. Do not change, replace, upload, merge, hash for upload, or reinterpret Hermes `MEMORY.md`, `USER.md`, sessions, files, skills, Curator state, Profile layout, background review, or self-learning behavior.
2. Do not reuse `src/main/hermes-account.ts`, `src/main/account-store.ts`, Remote Dashboard OAuth, or recharge-site identity as AgentEra product authentication.
3. Do not send AgentEra tokens to local, remote, or SSH Runtime processes. The renderer receives only a public session projection, never access tokens, refresh tokens, private keys, or offline entitlements.
4. Do not allow plaintext fallback when platform secure storage is unavailable.
5. Do not push branches, open pull requests, deploy services, change DNS, or expose the server IP publicly without a separate user authorization at the relevant checkpoint.
6. Never stage `$DESKTOP/lat.md/.cache/vectors.db`, local databases, logs, secrets, test mail, build output, or generated credentials.
7. Treat the three milestones below as separate review points. Passing cloud tests does not prove desktop integration, and passing desktop tests does not supersede the Runtime compatibility gate.

This phase does not implement Hermes session/Memory/file sync, end-to-end encrypted backup, workspace/organization/enterprise policy, official Agent publishing/evolution, a full operations dashboard, or recharge-account linkage. Those remain separately specified later phases.

## Milestone A — Private `aera-cloud` service and browser account center

### Task 1: Bootstrap the private cloud repository and health contract

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/go.mod`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud/main.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/config.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/config_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/httpapi/server.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/httpapi/server_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/postgres.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/redis.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/testkit/services.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/compose.yaml`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.env.example`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.gitignore`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/README.md`

**Step 1: Clone the verified private, empty repository and create the product branch**

```bash
cd /Users/zizimutou/Desktop/aera
gh repo view bignormal/aera-cloud --json nameWithOwner,visibility,defaultBranchRef
git clone git@github.com:bignormal/aera-cloud.git "$CLOUD"
cd "$CLOUD"
git branch -M main
```

Expected: GitHub reports `PRIVATE` and an empty `defaultBranchRef.name`; the clone has no commits; the active unborn local branch is `main`. Stop if the repository is no longer empty or its owner/visibility differs.

**Step 2: Write failing configuration and health tests**

Define these public seams before implementation:

```go
package config

type LookupEnv func(string) (string, bool)

type Config struct {
    Environment string
    ListenAddr string
    PublicURL string
    DatabaseURL string
    RedisAddr string
    RedisUsername string
    RedisPassword string
    RedisDB int
}

func Load(lookup LookupEnv) (Config, error)
```

Tests must prove that production rejects an HTTP `PublicURL`, empty database/Redis credentials, and the recharge database name `agentera_claw`; development accepts loopback HTTP only. Define `httpapi.Dependencies` with explicit PostgreSQL and Redis readiness interfaces, and test:

- `GET /health/live` returns `200` without dependency calls.
- `GET /health/ready` returns `200` only when PostgreSQL and Redis both respond.
- Dependency failure returns `503` with `{"status":"unavailable"}` and no secret-bearing error text.

**Step 3: Run the focused tests to verify red**

```bash
cd "$CLOUD"
go test ./internal/config ./internal/httpapi
```

Expected: FAIL because `Config.Load` and `httpapi.New` do not exist.

**Step 4: Implement the minimal server and local service harness**

Initialize the module and dependencies:

```bash
go mod init github.com/bignormal/aera-cloud
go get github.com/go-chi/chi/v5 github.com/jackc/pgx/v5/pgxpool github.com/redis/go-redis/v9
```

Implement `config.Load`, connection constructors with bounded startup timeouts, `httpapi.New(deps) http.Handler`, graceful shutdown, and JSON logging that never prints raw configuration. `compose.yaml` must expose PostgreSQL and Redis only on loopback and use a dedicated database named `aera_cloud`.

**Step 5: Run tests and a real readiness check**

```bash
go test ./internal/config ./internal/httpapi
docker compose up -d postgres redis
set -a
source .env.example
set +a
go run ./cmd/aera-cloud &
CLOUD_PID=$!
for attempt in $(seq 1 40); do
  curl --fail --silent http://127.0.0.1:8086/health/live && break
  sleep 0.25
done
curl --fail --silent http://127.0.0.1:8086/health/live
curl --fail --silent http://127.0.0.1:8086/health/ready
kill "$CLOUD_PID"
docker compose down
```

Expected: both tests pass; both endpoints return a non-sensitive status body; the process exits cleanly.

**Step 6: Commit the repository baseline**

```bash
git add go.mod go.sum cmd internal compose.yaml .env.example .gitignore README.md
git commit -m "chore: bootstrap AgentEra cloud service"
git switch -c aera/app-auth-service
```

Expected: the first commit is the local `main` baseline and all subsequent cloud feature work occurs on `aera/app-auth-service`. Neither branch is pushed in this task.

### Task 2: Add the authentication schema and cryptographic primitives

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/migrations/000001_auth_schema.sql`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/migrate.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/migrate_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/secure/identity.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/secure/identity_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/secure/password.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/secure/password_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/secure/random.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/secure/random_test.go`

**Step 1: Write failing normalization, encryption, password, and migration tests**

Lock these interfaces:

```go
type IdentityKind string
const (
    IdentityEmail IdentityKind = "email"
    IdentityPhone IdentityKind = "phone"
)

func NormalizeIdentity(kind IdentityKind, raw string) (string, error)

type IdentityCodec interface {
    Seal(normalized string) (keyID string, nonce, ciphertext, lookupHMAC []byte, err error)
    Open(keyID string, nonce, ciphertext []byte) (string, error)
}

type PasswordHasher interface {
    Hash(password string) (encoded string, paramsVersion int, err error)
    Verify(password, encoded string) (ok bool, rehash bool, err error)
}
```

Tests must cover lowercase/trimmed email, mainland phone normalization to E.164 `+86...`, invalid phone rejection, randomized AES-GCM nonces, stable keyed lookup HMAC, old/new encryption-key verification, controlled HMAC reindexing during lookup-key rotation, wrong-key failure, 10–128 character password bounds, Argon2id verification, and parameter-version rehash signaling.

The migration test must apply to an empty database and then reapply idempotently. Assert the exact tables and constraints for `users`, `identities`, `password_credentials`, `personal_spaces`, `devices`, `sessions`, `verification_challenges`, `oauth_requests`, `authorization_codes`, `offline_entitlement_issuances`, `audit_events`, and `legal_acceptances`, including unique `(kind, lookup_hmac)` and unique active installation ownership.

**Step 2: Verify the tests fail**

```bash
go test ./internal/secure ./internal/store -run 'Test(Normalize|IdentityCodec|Password|Migration)'
```

Expected: FAIL on missing schema and implementations.

**Step 3: Implement versioned cryptography and forward-only migration**

Use independent environment-injected key rings for identity encryption and lookup HMAC. Use AES-256-GCM with a fresh 96-bit nonce per record; HMAC-SHA-256 over `kind || 0x00 || normalized`; Argon2id defaults documented in `.env.example`; constant-time comparisons; and at least 256-bit random values from `crypto/rand` for opaque tokens. Store UTC timestamps and UUID primary keys. Never store or log plaintext identities, passwords, codes, authorization codes, or tokens.

Add the concrete crypto and UUID dependencies before implementing:

```bash
go get golang.org/x/crypto/argon2 github.com/google/uuid
go mod tidy
```

**Step 4: Run focused and race tests**

```bash
go test ./internal/secure ./internal/store
go test -race ./internal/secure ./internal/store
```

Expected: PASS; race detector reports no races.

**Step 5: Commit**

```bash
git add migrations internal/secure internal/store .env.example go.mod go.sum
git commit -m "feat: add AgentEra auth storage foundation"
```

### Task 3: Implement verification challenges, abuse controls, and notification adapters

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/verification/model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/verification/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/verification/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/verification/service_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/verification/http.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/verification/http_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/verification/limiter.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/verification/limiter_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/notification/provider.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/notification/email_smtp.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/notification/sms_http.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/notification/provider_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/abuse/captcha.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/abuse/captcha_test.go`

**Step 1: Write failing service tests around explicit ports**

```go
type Purpose string

type Sender interface {
    SendVerification(ctx context.Context, destination, code string, purpose Purpose) error
}

type Repository interface {
    SaveAfterDelivery(ctx context.Context, challenge Challenge) error
    Consume(ctx context.Context, targetHMAC []byte, purpose Purpose, codeHMAC []byte, now time.Time) error
}

type Limiter interface {
    Allow(ctx context.Context, key string, policy Policy) (Decision, error)
}
```

Cover six numeric digits, five-minute expiry, sixty-second resend delay, invalidation after five failed attempts, one-time consumption, identity/IP/device limits, abnormal-frequency CAPTCHA escalation, Redis failure closed, and provider failure leaving no usable challenge. Ensure the fake sender captures codes only in tests and production logging redacts destinations and codes.

**Step 2: Run the tests to verify red**

```bash
go test ./internal/verification ./internal/notification ./internal/abuse
```

Expected: FAIL on missing service behavior.

**Step 3: Implement challenge delivery and HTTP endpoints**

Expose versioned endpoints:

```text
POST /api/v1/verification/challenges
POST /api/v1/verification/challenges/verify
```

Hash verification codes with a dedicated keyed HMAC before persistence. Persist a challenge only after the provider accepts delivery; use an idempotency key to prevent duplicate sends on client retry. Map failures to stable error codes without revealing whether an untrusted identity already exists.

**Step 4: Prove failure behavior and log redaction**

```bash
go test ./internal/verification ./internal/notification ./internal/abuse
go test -race ./internal/verification
go test ./internal/verification -run TestLogsNeverContainSecrets -v
```

Expected: PASS; the captured log does not contain the destination, code, HMAC, or provider secret.

**Step 5: Commit**

```bash
git add internal/verification internal/notification internal/abuse cmd internal/httpapi
git commit -m "feat: add identity verification challenges"
```

### Task 4: Build registration, login, password recovery, and the personal-space transaction

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/service_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/http.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/http_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/space/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/legal/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/browser/session.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/browser/session_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/audit/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml`

**Step 1: Write failing account transaction tests**

Define commands rather than allowing HTTP handlers to write tables directly:

```go
type RegisterCommand struct {
    Kind secure.IdentityKind
    VerificationReceipt string
    Password string
    Nickname string
    TermsVersion string
    PrivacyVersion string
}

type Registration struct {
    UserID uuid.UUID
    PersonalSpaceID uuid.UUID
}

func (s *Service) Register(ctx context.Context, cmd RegisterCommand) (Registration, error)
func (s *Service) AuthenticatePassword(ctx context.Context, identity, password string) (Principal, error)
func (s *Service) ResetPassword(ctx context.Context, receipt, newPassword string) error
```

Tests must prove:

- registration atomically creates one user, one verified identity, one password credential, current legal acceptances, and one personal space;
- rollback leaves none of those records when any insert fails;
- the same normalized identity cannot race into two users;
- email and phone are interchangeable login identifiers after binding;
- nickname is optional and no username is generated;
- only server-current terms and privacy versions are accepted;
- invalid credentials return the same public error for unknown identity and wrong password;
- password recovery consumes one verification receipt and revokes all existing session families.

**Step 2: Run the focused tests to verify red**

```bash
go test ./internal/account ./internal/browser ./internal/legal
```

Expected: FAIL because the transaction service and browser session do not exist.

**Step 3: Implement the account API and stable error envelope**

Add these browser-facing API operations to `api/openapi.yaml` and bind generated-independent Go request types by hand so the OpenAPI document remains the contract, not a generator side effect:

```text
POST /api/v1/accounts/register
POST /api/v1/browser/login
POST /api/v1/browser/logout
POST /api/v1/accounts/password/reset
GET  /api/v1/legal/current
```

All errors use:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "localized by the client",
    "request_id": "opaque-id"
  }
}
```

Lock the public code set to `invalid_request`, `verification_required`, `identity_conflict`, `invalid_credentials`, `device_limit_reached`, `authorization_expired`, `authorization_replayed`, `session_revoked`, `account_pending_deletion`, `account_disabled`, and `service_unavailable`. Browser session cookies must be host-only, `HttpOnly`, `Secure` outside loopback development, `SameSite=Lax`, short lived, and CSRF protected on state-changing requests.

Apply configurable password-login rate limits by normalized identity HMAC and IP, use constant-shape error responses for unknown identity and wrong password, and record only redacted success/failure audit metadata.

**Step 4: Verify transaction, contract, and browser-session behavior**

```bash
go test ./internal/account ./internal/browser ./internal/legal ./internal/audit
go test -race ./internal/account
go test ./internal/account -run 'TestConcurrentRegistrationUsesOneIdentity' -count=20
```

Expected: PASS for every repetition; the database contains one owner for the contested identity.

**Step 5: Commit**

```bash
git add internal/account internal/space internal/legal internal/browser internal/audit api cmd internal/httpapi
git commit -m "feat: add AgentEra account registration"
```

### Task 5: Implement desktop OAuth, device sessions, refresh rotation, and offline entitlements

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/oauth/model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/oauth/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/oauth/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/oauth/service_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/oauth/http.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/oauth/http_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/device/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/device/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/device/service_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/session/access.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/session/access_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/session/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/session/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/session/service_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/entitlement/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/entitlement/service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml`

**Step 1: Write failing protocol and concurrency tests**

The cloud contract must use these wire-level properties:

```go
type TokenResponse struct {
    AccessToken string `json:"access_token"`
    AccessExpiresAt time.Time `json:"access_expires_at"`
    RefreshToken string `json:"refresh_token"`
    RefreshExpiresAt time.Time `json:"refresh_expires_at"`
    OfflineEntitlement string `json:"offline_entitlement"`
    OfflineExpiresAt time.Time `json:"offline_expires_at"`
    UserID uuid.UUID `json:"user_id"`
    PersonalSpaceID uuid.UUID `json:"personal_space_id"`
    DeviceID uuid.UUID `json:"device_id"`
}
```

Write tests for fixed `client_id=agentera-studio`, S256-only PKCE, an exact redirect shape of `http://127.0.0.1:{dynamic-port}/agentera/oauth/callback`, two-minute authorization-code expiry, hash-only code storage, atomic one-time exchange, device-key proof, and original `state` echo. The device proof signs the SHA-256 digest of `authorization_code || NUL || code_verifier || NUL || installation_id` with the submitted Ed25519 device key.

Add concurrent tests that authorize devices 1–5, run two sixth-device exchanges simultaneously, and assert neither succeeds until one existing device is revoked. Add refresh tests proving thirty-day rolling rotation, reuse of a replaced token revoking the whole family, and concurrent refresh allowing only one successor. Add entitlement tests for independent Ed25519 signing, `kid`, seven-day expiry, user/device/installation/personal-space binding, policy version, and issuance audit.

**Step 2: Verify the focused suite is red**

```bash
go test ./internal/oauth ./internal/device ./internal/session ./internal/entitlement
```

Expected: FAIL on missing protocol services.

**Step 3: Implement the OAuth and token endpoints**

Expose:

```text
GET  /oauth/authorize
POST /api/v1/oauth/authorize/approve
POST /api/v1/oauth/token
POST /api/v1/oauth/refresh
POST /api/v1/oauth/revoke
GET  /.well-known/agentera-signing-keys.json
```

Use a transaction or PostgreSQL advisory lock per user while enforcing the five-active-device cap. Access JWTs last fifteen minutes and contain only issuer, audience, user ID, session ID, device ID, personal-space ID, issued-at, and expiry. Every authenticated cloud request must check signature/time and then the Redis-backed revocation view whose PostgreSQL record remains authoritative. Refresh and offline signing keys are independent from access signing keys.

**Step 4: Run repeatable security and race tests**

```bash
go test ./internal/oauth ./internal/device ./internal/session ./internal/entitlement
go test -race ./internal/oauth ./internal/device ./internal/session ./internal/entitlement
go test ./internal/oauth -run 'TestAuthorizationCodeIsSingleUse' -count=50
go test ./internal/device -run 'TestConcurrentSixthDeviceIsRejected' -count=50
go test ./internal/session -run 'TestConcurrentRefreshHasOneWinner' -count=50
```

Expected: PASS for all repetitions; replay attempts return `authorization_replayed` or `session_revoked` as appropriate.

**Step 5: Commit**

```bash
git add internal/oauth internal/device internal/session internal/entitlement api cmd internal/httpapi
git commit -m "feat: add desktop authorization sessions"
```

### Task 6: Complete account lifecycle, devices, deletion recovery, jobs, and restricted operations

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/lifecycle.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/lifecycle_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/device/http.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/device/http_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/jobs/runner.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/jobs/runner_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/admin/commands.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/admin/commands_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud-admin/main.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/account/http.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml`

**Step 1: Write failing lifecycle tests**

Cover binding the other identity only after current-password reauthentication and new-identity verification; refusal to bind an identity owned by another user; refusal to remove the last login identity; password change preserving the current session while revoking every other device; current-device logout; device-list redaction; device revocation; deletion requiring password plus verification receipt; immediate `pending_deletion` state and revocation; recovery only within seven days; and finalization after seven days that removes identity lookup indexes and anonymizes retained security audit. Add a signed self-revocation test: a device can revoke only its own `device_id` with its registered Ed25519 key, nonce, and short timestamp window; nonce replay, another device ID, and stale signatures fail. Sign the SHA-256 digest of `"agentera-self-revoke" || NUL || device_id || NUL || installation_id || NUL || timestamp || NUL || nonce`.

Use an injected clock. The finalizer test must prove it never opens, enumerates, or deletes any desktop/Hermes path because the cloud process has no such interface.

**Step 2: Run tests to verify red**

```bash
go test ./internal/account ./internal/device ./internal/jobs ./internal/admin
```

Expected: FAIL on missing lifecycle transitions.

**Step 3: Implement self-service and lease-protected jobs**

Add authenticated APIs for profile metadata, identity binding, password change, devices, logout, deletion, and recovery. Add `POST /api/v1/devices/self-revoke` for a device-signed pending logout; it accepts no target other than the signing device and stores consumed nonces. Run challenge cleanup, authorization-code cleanup, expired-session cleanup, and deletion finalization in the application process under a PostgreSQL or Redis lease. Redis failure must pause the job rather than run duplicate destructive work.

`aera-cloud-admin` must be a server-side CLI with commands for account disable/enable, session revoke, and redacted audit lookup. It must require an explicit operator identity, write an audit event, and have no public HTTP route.

**Step 4: Verify lifecycle boundaries**

```bash
go test ./internal/account ./internal/device ./internal/jobs ./internal/admin
go test -race ./internal/jobs
go test ./internal/account -run 'TestDeletionFinalizationReleasesIdentity' -count=10
```

Expected: PASS; a recovered account remains usable, a finalized identity can register again, and audit output stays de-identified.

**Step 5: Commit**

```bash
git add internal/account internal/device internal/jobs internal/admin cmd/aera-cloud-admin api
git commit -m "feat: complete AgentEra account lifecycle"
```

### Task 7: Build the browser account center and OAuth approval UI

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/package.json`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/package-lock.json`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/vite.config.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/main.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/router.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/api/client.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/auth/csrf.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/pages/LoginPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/pages/RegisterPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/pages/ForgotPasswordPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/pages/AuthorizePage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/pages/AccountPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/pages/DevicesPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/pages/DeleteAccountPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/i18n/zh-CN.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/src/i18n/en.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/web/tests/account-center.spec.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/webui/assets.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/webui/assets_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud/main.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/httpapi/server.go`

**Step 1: Write failing component and browser tests**

Use React Testing Library for form state and Playwright for full flows. Tests must cover email registration, mainland phone registration, login, forgot password, binding the second identity, five-device overflow with explicit revocation, OAuth approve/cancel/expired request, account deletion warning and recovery, Chinese default copy, English switch, keyboard navigation, and sensitive values absent from URLs and browser console logs.

**Step 2: Verify red**

```bash
cd "$CLOUD/web"
npm ci
npm test -- --run
npx playwright test
```

Expected: FAIL because routes and forms are not implemented.

**Step 3: Implement the account center**

Create routes `/login`, `/register`, `/forgot-password`, `/authorize`, `/account`, `/devices`, and `/delete-account`. Password and verification-code inputs stay entirely in the browser/cloud path. The authorization-success page says the user can return to AgentEra Studio and never renders a token. Device overflow must show active devices and require an explicit revoke action before retrying authorization.

Build static assets into `web/dist` and embed them in the Go binary or copy them into the single application image. Unknown non-API paths fall back to the SPA; API and health paths never do.

**Step 4: Run UI and Go integration checks**

```bash
cd "$CLOUD/web"
npm test -- --run
npx playwright test
npm run build
cd "$CLOUD"
go test ./internal/httpapi ./internal/account ./internal/oauth
go build ./cmd/aera-cloud
```

Expected: PASS; the Go binary serves the built account center and versioned API without exposing credentials.

**Step 5: Commit**

```bash
git add web cmd internal/httpapi
git commit -m "feat: add AgentEra browser account center"
```

### Task 8: Add reproducible deployment, backup/restore, CI, and private-staging runbooks

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/Dockerfile`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/deploy/compose.production.yaml`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/deploy/Caddyfile.example`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/deploy/backup.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/deploy/restore-verify.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/docs/runbooks/private-staging.md`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/docs/runbooks/production.md`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/docs/runbooks/key-rotation.md`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/docs/runbooks/account-recovery.md`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/smoke-auth.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/check-secrets.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.github/workflows/ci.yml`

**Step 1: Write failing deployment and secret-boundary checks**

`scripts/check-secrets.sh` must reject committed `.env` files, PEM private keys, token-shaped fixtures, plaintext verification codes, and production fake providers. `scripts/smoke-auth.sh` must exercise health, a test-provider registration, browser session creation, PKCE exchange, refresh rotation, revoke, and post-revoke rejection against an isolated test stack.

**Step 2: Run the checks before implementation**

```bash
cd "$CLOUD"
./scripts/check-secrets.sh
docker compose -f compose.yaml up -d --build
./scripts/smoke-auth.sh
```

Expected: FAIL because the image, scripts, and smoke fixtures are incomplete.

**Step 3: Implement the single-container deployment contract**

Build React assets, then the Go binary, then a minimal runtime image. Set application limits to 0.5–1 vCPU and 256–512 MB. Production Compose must use a dedicated `aera_cloud` database role/database, a dedicated Redis ACL username and database/namespace, an independent cookie name, independent encryption/HMAC/signing secrets, and an independent HTTPS origin. It must not join the recharge application network unless required solely to reach shared infrastructure.

The private-staging runbook permits the server IP only behind VPN, SSH tunnel, or a strict developer IP allowlist. The production runbook blocks public registration until a filed domain, trusted HTTPS, real mail/SMS providers, privacy policy, terms, encrypted backup, and tested restore are present.

The key-rotation runbook must require an overlap release: ship a desktop build containing the next offline public `kid`, confirm adoption, begin signing new entitlements with that key, retain the previous public key through its final seven-day expiry, and only then retire it. A cloud-only offline-signing-key switch is prohibited.

`backup.sh` creates an encrypted PostgreSQL backup without secret files. `restore-verify.sh` restores into a disposable database, runs integrity queries, proves encrypted identities still decrypt with the supplied recovery key set, and destroys the disposable database.

**Step 4: Run the full cloud gate**

```bash
cd "$CLOUD"
go test ./...
go test -race ./internal/secure ./internal/verification ./internal/oauth ./internal/device ./internal/session ./internal/jobs
cd "$CLOUD/web" && npm ci && npm test -- --run && npm run build
cd "$CLOUD"
docker compose -f compose.yaml up -d --build
./scripts/smoke-auth.sh
./scripts/check-secrets.sh
docker compose -f compose.yaml down -v
```

Expected: every command passes; the smoke stack is destroyed; no test database, test mail, logs, or secrets remain tracked.

**Step 5: Commit the cloud milestone**

```bash
git add Dockerfile deploy docs scripts .github compose.yaml README.md
git commit -m "chore: harden AgentEra cloud delivery"
git status --short
```

Expected: clean cloud worktree. Stop for Milestone A review; do not push or deploy without separate authorization.

## Milestone B — AgentEra Studio authentication gate and local ownership

Before this milestone, return to the reviewed desktop design commit and create the implementation branch. Do not merge cloud source into the desktop repository; the two sides integrate only through `api/openapi.yaml` and test fixtures.

```bash
cd "$DESKTOP"
git status --short --branch
git switch -c aera/app-authentication aera/app-auth-design
```

Expected: the implementation branch contains the approved design and this plan; the only permitted pre-existing worktree item is untracked `lat.md/.cache/vectors.db`.

### Task 9: Define renderer-safe auth types, endpoint configuration, and secure app-level storage

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/config.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/store.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/device-key.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-auth-config.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-auth-store.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-device-key.test.ts`

**Step 1: Write failing public-state and secure-store tests**

Use a discriminated public state with no optional secret-bearing fields:

```ts
export type AgenteraAuthPublicState =
  | { status: "checking" }
  | { status: "unauthenticated"; reason?: AgenteraAuthBlockReason }
  | {
      status: "authenticated" | "offline";
      userId: string;
      personalSpaceId: string;
      deviceId: string;
      offlineExpiresAt: string;
      cloudAvailable: boolean;
    }
  | { status: "blocked"; reason: AgenteraAuthBlockReason };

export type AgenteraAuthBlockReason =
  | "sign_in_required"
  | "offline_expired"
  | "clock_rollback"
  | "device_revoked"
  | "account_disabled"
  | "account_pending_deletion"
  | "secure_storage_unavailable";
```

Define a testable secure-storage adapter:

```ts
export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
```

Tests must prove endpoint configuration accepts HTTPS and loopback-development HTTP, rejects non-loopback HTTP, embedded credentials, paths outside the configured origin, and any recharge-site origin. Store tests must prove:

- installation ID and Ed25519 device key survive logout;
- refresh token, offline entitlement, and pending revocation are encrypted atomically under Electron `app.getPath("userData")`, never under `HERMES_HOME` or a Profile;
- access tokens remain memory-only;
- logout removes product session material but leaves installation identity and Profile bindings untouched;
- unavailable `safeStorage` rejects persistence without a plaintext fallback;
- the public-state serializer cannot expose a token, key, code, verifier, or encrypted blob.

**Step 2: Run tests to verify red**

```bash
cd "$DESKTOP"
npm test -- tests/agentera-auth-config.test.ts tests/agentera-auth-store.test.ts tests/agentera-device-key.test.ts
```

Expected: FAIL because the AgentEra auth modules do not exist.

**Step 3: Implement the minimal store and device identity**

Read the cloud origin from `AGENTERA_CLOUD_PUBLIC_URL` at runtime/build configuration rather than hard-coding a domain or IP. Store one versioned encrypted JSON envelope plus an unencrypted schema/version marker; use the existing `safeWriteFile` pattern for replace-on-success semantics. Generate an installation-scoped Ed25519 key pair with Node `crypto`; encrypt the private key before disk write. Bundle only the approved offline public verification keys keyed by `kid`.

Keep these internal records separate:

```ts
interface InstallationRecord {
  installationId: string;
  devicePublicKey: string;
  encryptedDevicePrivateKey: string;
}

interface ProductSessionRecord {
  userId: string;
  personalSpaceId: string;
  deviceId: string;
  encryptedRefreshToken: string;
  encryptedOfflineEntitlement: string;
  offlineExpiresAt: string;
  lastTrustedServerTime: string;
}
```

**Step 4: Run focused tests, type checking, and secret-name scan**

```bash
npm test -- tests/agentera-auth-config.test.ts tests/agentera-auth-store.test.ts tests/agentera-device-key.test.ts
npm run typecheck
rg -n "refreshToken|offlineEntitlement|devicePrivateKey|accessToken" src/renderer src/preload
```

Expected: tests and typecheck pass; the scan finds type-level forbidden-key assertions only, not renderer/preload data fields or values.

**Step 5: Commit**

```bash
git add src/shared/agentera-auth.ts src/main/agentera-auth tests/agentera-auth-config.test.ts tests/agentera-auth-store.test.ts tests/agentera-device-key.test.ts
git commit -m "feat: add AgentEra product auth storage"
```

### Task 10: Add the loopback PKCE client, cloud client, IPC, and preload surface

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/loopback.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/pkce.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/client.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/controller.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-auth-loopback.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-auth-client.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-auth-controller.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/app/start.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.d.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/preload-api-surface.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/security.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/electron-security.test.ts`

**Step 1: Write failing loopback and protocol tests**

Tests must verify that one login attempt:

1. Generates a 256-bit random `state`, a high-entropy PKCE verifier, S256 challenge, and a new listener bound to `127.0.0.1:0`.
2. Registers exactly `http://127.0.0.1:{assigned-port}/agentera/oauth/callback` and opens the system browser through the existing centralized external-URL policy.
3. Accepts only `GET` on that exact path, validates `state`, consumes one callback, responds with a non-sensitive success page, closes the listener, and restores the desktop window.
4. Rejects missing/wrong state, duplicate callback, oversized query, unrelated path, non-loopback binding, timeout, browser cancel, and port/listener error.
5. Exchanges the code with verifier, installation ID, public key, and an Ed25519 signature over the protocol digest; never places a token in a URL.
6. Creates an entirely new listener/state/verifier on retry and requests account selection instead of silently reusing the previous browser account during account switching.

Use an in-process fake HTTPS/loopback cloud server and injected `openExternal`, clock, and random source. Do not open a real browser in unit tests.

**Step 2: Verify tests fail**

```bash
npm test -- tests/agentera-auth-loopback.test.ts tests/agentera-auth-client.test.ts tests/agentera-auth-controller.test.ts
```

Expected: FAIL on missing controller and callback implementation.

**Step 3: Implement main-process-only authentication orchestration**

The controller owns transient access tokens and exposes only:

```ts
export interface AgenteraAuthController {
  initialize(): Promise<AgenteraAuthPublicState>;
  getPublicState(): AgenteraAuthPublicState;
  startBrowserLogin(options?: {
    forceAccountSelection?: boolean;
  }): Promise<void>;
  cancelBrowserLogin(): Promise<void>;
  refreshOnline(): Promise<AgenteraAuthPublicState>;
  logout(): Promise<void>;
  subscribe(listener: (state: AgenteraAuthPublicState) => void): () => void;
}
```

Instantiate it once in `startMainProcess`, inject it into `registerIpcHandlers`, and close its listener/timers during `before-quit`. Add a namespaced preload surface:

```ts
agenteraAuth: {
  getState(): Promise<AgenteraAuthPublicState>;
  startLogin(options?: { forceAccountSelection?: boolean }): Promise<void>;
  cancelLogin(): Promise<void>;
  retryOnline(): Promise<AgenteraAuthPublicState>;
  logout(): Promise<void>;
  onStateChanged(listener: (state: AgenteraAuthPublicState) => void): () => void;
}
```

Allow only the configured AgentEra cloud origin and exact OAuth path through the external URL policy. This must not broaden general navigation or the existing webview allowlist.

**Step 4: Run protocol, preload, and Electron security tests**

```bash
npm test -- tests/agentera-auth-loopback.test.ts tests/agentera-auth-client.test.ts tests/agentera-auth-controller.test.ts tests/preload-api-surface.test.ts tests/electron-security.test.ts
npm run typecheck
```

Expected: PASS; preload declaration and implementation have identical methods; external navigation remains deny-by-default.

**Step 5: Commit**

```bash
git add src/main/agentera-auth src/main/app/start.ts src/main/ipc/register.ts src/main/security.ts src/preload tests
git commit -m "feat: add AgentEra browser authorization client"
```

### Task 11: Add non-destructive Profile ownership and guarded Runtime contexts

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-profile-binding.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-connection-owner.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-startup-preflight.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/auth-guard.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-profile-binding.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-connection-owner.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-startup-preflight.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-ipc-auth-guard.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/fixtures/hermes-profile-boundary/MEMORY.md`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/fixtures/hermes-profile-boundary/USER.md`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/fixtures/hermes-profile-boundary/sessions/session.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/fixtures/hermes-profile-boundary/skills/learned/SKILL.md`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/fixtures/hermes-profile-boundary/curator/state.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/profiles.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/config.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/app/start.ts`

**Step 1: Write failing ownership and immutability tests**

Persist the minimum contract exactly:

```ts
export interface RuntimeOwnerBinding {
  tenantId: string; // personal_space_id
  ownerScope: "USER";
  ownerId: string; // cloud_user_id
  installationId: string;
  runtimeProfileId: string;
  boundAt: string;
}
```

Tests must hash every fixture file before and after these operations: detect meaningful data, bind the current physical Profile in place, log out, log back into the same account, reject another account, create a separate fresh Profile, and encounter cloud failure. Every hash and path must remain identical. The detector may use path existence, file type, size, and approved metadata filenames, but must not parse or upload the private contents.

A fresh Profile test must spy on `createProfile` and require `cloneFrom === null`; fail if any source Profile, key, Memory, USER, skill, or Curator path is passed. Add a unique ownership test proving one physical Profile cannot be bound twice or reassigned after cloud account deletion.

Add a stable `connectionContextId` to desktop connection metadata. Remote/SSH credentials and configuration remain locally stored but can be mounted only when the context owner matches the authenticated AgentEra owner. Changing remote URL, SSH host, or credential material creates an unowned context that requires explicit binding by the current authenticated user.

**Step 2: Write the IPC gate inventory test**

Create a central channel policy with three levels:

```ts
export type ProductAccessLevel =
  | "preflight"
  | "authenticated"
  | "bound-profile";

export interface ProductAccessGuard {
  assert(level: ProductAccessLevel): void;
}
```

The test must use the TypeScript compiler AST to enumerate every `ipcMain.handle` and `ipcMain.on` channel in `src/main/ipc/register.ts` and fail if a channel lacks an explicit policy. Permit only a sanitized startup-preflight result, install-file probe, app metadata, locale, and AgentEra auth itself at `preflight`; require `authenticated` for Runtime installation, direct connection config reads/edits, fresh Profile creation, and setup; require `bound-profile` for chat, sessions, Memory, files, skills, Curator-facing data, model execution, remote/SSH user data, and task start.

The startup preflight runs connection/install checks in the main process and returns only `{ connectionMode, postAuthTarget, verifyWarning }`. It may test reachability as allowed by the design, but it cannot return the previous remote URL, SSH host/user/key path, API-key metadata, Profile name, sessions, Memory, or other owner data to the unauthenticated renderer.

**Step 3: Run tests to verify red**

```bash
npm test -- tests/agentera-profile-binding.test.ts tests/agentera-connection-owner.test.ts tests/agentera-startup-preflight.test.ts tests/agentera-ipc-auth-guard.test.ts
```

Expected: FAIL because ownership and centralized IPC policy do not exist.

**Step 4: Implement app-level ownership without changing Runtime data**

Store encrypted, versioned ownership metadata under Electron `userData`, outside `HERMES_HOME`. Use absolute canonical Profile paths plus `runtimeProfileId`; do not infer ownership from an editable Profile name. Expose operations to inspect claim status, bind existing in place, create-and-bind fresh, list unbound local Profiles after authentication, and verify active binding. There is no ordinary unbind or cross-account reassignment operation.

Wrap IPC registration with the central policy rather than relying on renderer routing. Authentication failure must stop before a Runtime handler reads user data. Preserve splash preflight, but it must not mount a Profile or return sessions/Memory. Close the cached DB and stop local/remote/SSH task processes before switching the active owner.

**Step 5: Run ownership, full desktop, and immutable-fixture tests**

```bash
npm test -- tests/agentera-profile-binding.test.ts tests/agentera-connection-owner.test.ts tests/agentera-startup-preflight.test.ts tests/agentera-ipc-auth-guard.test.ts
npm test
npm run typecheck
```

Expected: PASS; fixture hashes are unchanged; every IPC channel has one access level; existing Hermes account and Remote Dashboard OAuth tests remain green.

**Step 6: Commit**

```bash
git add src/main/agentera-profile-binding.ts src/main/agentera-connection-owner.ts src/main/agentera-startup-preflight.ts src/main/ipc src/main/profiles.ts src/main/config.ts src/main/app/start.ts tests
git commit -m "feat: bind local runtime profiles to AgentEra owners"
```

### Task 12: Insert the post-splash auth gate and Profile-claim state machine

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/AuthGate/AuthGate.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/AuthGate/AuthGate.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/ProfileClaim/ProfileClaim.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/ProfileClaim/ProfileClaim.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/App.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ar/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/en/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/es/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/he/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/id/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ja/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pl/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-BR/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-PT/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/tr/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-CN/auth.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-TW/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/App.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/assets/main.css`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.d.ts`

**Step 1: Write the failing startup matrix before changing `App.tsx`**

Represent the existing install/connection result as a stored target, not an immediate route:

```ts
type PostAuthTarget = "welcome" | "setup" | "main";
type Screen =
  | "splash"
  | "auth"
  | "profile-claim"
  | "welcome"
  | "installing"
  | "setup"
  | "main";
```

Use fake timers and preload mocks to test the complete matrix:

| Preflight result  | Auth state              | Ownership state              | Required screen                |
| ----------------- | ----------------------- | ---------------------------- | ------------------------------ |
| any target        | unauthenticated/blocked | any                          | `auth` after splash            |
| `welcome`         | authenticated/offline   | installation identity exists | `welcome`                      |
| `setup`           | authenticated/offline   | unbound                      | `profile-claim`                |
| `main` local      | authenticated/offline   | matching Profile             | `main`                         |
| `main` remote/SSH | authenticated/offline   | matching connection context  | `main`                         |
| `setup`/`main`    | authenticated/offline   | owned by another user        | `profile-claim` with rejection |

Add the fresh-install sequence test: `splash -> auth -> welcome -> installing -> profile-claim -> setup`, with no path from install completion directly to `setup`. Add a meaningful-existing-data test requiring an explicit “use existing local data” choice, and a “create new space” test requiring a fresh non-cloned Profile while preserving the old path and hashes.

**Step 2: Verify the startup tests fail**

```bash
npm test -- src/renderer/src/App.test.tsx src/renderer/src/screens/AuthGate/AuthGate.test.tsx src/renderer/src/screens/ProfileClaim/ProfileClaim.test.tsx
```

Expected: FAIL because the screen states and components do not exist.

**Step 3: Implement the state machine without changing splash behavior**

Keep the existing three-second splash, animated background, connection/install checks, warning behavior, and local-switch action. Replace the renderer's direct connection-config read with the sanitized main-process startup preflight, save its `postAuthTarget`, query `agenteraAuth.getState`, then resolve authentication and ownership before entering a user-data screen.

`AuthGate` contains AgentEra branding, status/error copy, one “Open browser to sign in or register” action, retry/cancel handling, and a secure-storage failure explanation. It contains no password, phone, email, verification-code, embedded webview, or hidden local-mode bypass.

`ProfileClaim` shows only after authentication. For meaningful existing data it offers exactly “Use existing local data” and “Create a new space,” explains that neither option uploads data, and does nothing until the user chooses. For an empty install it creates/binds an empty Profile without presenting a misleading migration choice. Remote/SSH mode binds the connection context rather than inheriting a previous owner.

Add complete Chinese and English copy; provide reviewed translations for the other existing locale files in the same commit. Keep RTL behavior for Arabic and Hebrew.

**Step 4: Run component, startup, locale, and accessibility checks**

```bash
npm test -- src/renderer/src/App.test.tsx src/renderer/src/screens/AuthGate/AuthGate.test.tsx src/renderer/src/screens/ProfileClaim/ProfileClaim.test.tsx tests/preload-api-surface.test.ts
npm test -- src/shared/i18n
npm run typecheck
```

Expected: PASS; every supported locale contains the same auth keys; keyboard focus stays within actionable controls; no route reaches `setup` or `main` without the required owner state.

**Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/App.test.tsx src/renderer/src/screens/AuthGate src/renderer/src/screens/ProfileClaim src/renderer/src/assets/main.css src/shared/i18n src/preload
git commit -m "feat: require AgentEra login after splash"
```

### Task 13: Enforce rolling offline access, revocation, safe logout, and account controls

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/entitlement.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/lifecycle.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/time-anchor.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/AgenteraOfflineBanner.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/AgenteraAccountMenu.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/AgenteraAccountPane.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-offline-entitlement.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-auth-lifecycle.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-time-anchor.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/AgenteraAccountMenu.test.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/AgenteraAccountPane.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/controller.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/auth-guard.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/app/start.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/SettingsModal.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ar/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/en/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/es/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/he/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/id/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ja/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pl/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-BR/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-PT/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/tr/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-CN/auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-TW/auth.ts`

**Step 1: Write failing entitlement and lifecycle tests**

Verify the offline entitlement with the bundled public key selected by `kid`, strict issuer/audience, user, device, installation, personal space, `jti`, policy version, issue time, and expiry. Reject unknown keys, malformed claims, copied-device credentials, expiry, future issue time, and altered payload/signature.

Use injected wall and monotonic clocks to cover:

- online startup validating server state and replacing the entitlement with a full new seven-day window;
- access refresh at fifteen minutes and refresh-token rotation;
- control-plane outage with a valid entitlement entering local offline mode;
- model endpoint behavior remaining independent from control-plane reachability;
- cloud-only features paused while local Hermes work and learning continue;
- network recovery validating automatically without restart;
- seven-day expiry blocking a new task while allowing a running task to save and stop safely;
- wall-clock rollback beyond tolerance requiring online validation;
- device/account revocation blocking new work immediately when online;
- current-user logout clearing only product session material and never deleting or unbinding a Profile.

**Step 2: Verify tests fail**

```bash
npm test -- tests/agentera-offline-entitlement.test.ts tests/agentera-auth-lifecycle.test.ts tests/agentera-time-anchor.test.ts src/renderer/src/components/AgenteraAccountMenu.test.tsx src/renderer/src/components/settings/AgenteraAccountPane.test.tsx
```

Expected: FAIL on missing lifecycle enforcement.

**Step 3: Implement online-first validation with the signed offline exception**

At startup and network recovery, validate the server session, rotate refresh, and replace the entitlement. Use bounded exponential backoff with jitter for control-plane retry. A verified, unexpired entitlement is the only offline exception; there is no environment flag, local-mode switch, or renderer command that bypasses it.

Before every new user task, the main-process IPC guard checks the current lifecycle state. On expiry, revocation, disable, or deletion, block new work, request a safe stop of `activeRuns`, wait for bounded cleanup, close cached data connections, and transition to the auth gate without modifying local files.

The account menu shows online/offline state, offline expiry, “Manage account” and “Manage devices” links on the configured cloud origin, “Switch account,” and “Sign out.” Switching requests browser account selection and cannot mount the previous owner’s Profile. The account settings pane explains that cloud account deletion does not delete local Hermes data.

Online logout revokes the cloud device before local clearing. If the cloud cannot be reached, create an encrypted, device-signed pending self-revocation record, clear the local product session, remain at the auth gate, and retry delivery when connectivity returns; show that the server may count the device until delivery succeeds. The record contains no bearer token and cannot revoke another device.

**Step 4: Run lifecycle, IPC, renderer, and full desktop tests**

```bash
npm test -- tests/agentera-offline-entitlement.test.ts tests/agentera-auth-lifecycle.test.ts tests/agentera-time-anchor.test.ts tests/agentera-ipc-auth-guard.test.ts src/renderer/src/components/AgenteraAccountMenu.test.tsx src/renderer/src/components/settings/AgenteraAccountPane.test.tsx
npm test
npm run typecheck
npm run build
```

Expected: PASS; the production build completes; offline mode preserves local work; logout and revocation never alter fixture hashes.

**Step 5: Commit the desktop milestone**

```bash
git add src/main/agentera-auth src/main/ipc src/main/app/start.ts src/renderer src/shared/i18n tests
git commit -m "feat: enforce AgentEra offline authorization"
git status --short
```

Expected: only `?? lat.md/.cache/vectors.db` may remain. Stop for Milestone B review; do not stage the cache or push the branch.

## Milestone C — Contract integration, Hermes protection, and release evidence

### Task 14: Pin the API contract and execute cross-repository release gates

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/contracts/agentera-cloud.openapi.yaml`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-cloud-api.generated.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/generate-agentera-cloud-types.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/check-agentera-cloud-contract.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/agentera-auth-smoke.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/agentera-cloud-contract.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-auth.e2e.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/docs/release/agentera-app-authentication-verification.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package-lock.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/ci.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-auth/client.ts`

**Step 1: Pin and generate the cross-repository contract**

Copy the reviewed cloud contract and generate deterministic TypeScript types:

```bash
cd "$DESKTOP"
mkdir -p contracts
cp "$CLOUD/api/openapi.yaml" contracts/agentera-cloud.openapi.yaml
npm install --save-dev openapi-typescript
npm run generate:agentera-cloud
cp src/shared/agentera-cloud-api.generated.ts /tmp/agentera-cloud-api.generated.ts
npm run generate:agentera-cloud
cmp /tmp/agentera-cloud-api.generated.ts src/shared/agentera-cloud-api.generated.ts
rm /tmp/agentera-cloud-api.generated.ts
```

The generator script writes only `src/shared/agentera-cloud-api.generated.ts`. The check script compares the pinned contract SHA-256, required endpoints, field names, error codes, and redirect constraints with the sibling cloud contract when available; CI verifies generated output is current without requiring a sibling checkout.

**Step 2: Write the failing end-to-end desktop flow**

The E2E harness launches an isolated cloud stack with test-only mail/SMS capture, an isolated Electron `userData` directory, and a copied Hermes boundary fixture. Automate:

1. Splash preflight and forced auth gate.
2. Browser registration through a loopback callback.
3. Personal-space receipt and fresh Profile binding.
4. Main-screen entry and a local no-op task boundary.
5. Offline relaunch with a valid entitlement.
6. Online recovery and seven-day renewal.
7. Device revoke, safe task stop, and auth-gate return.
8. Same-account re-login preserving Profile hashes.
9. Different-account login rejecting the existing binding.
10. Logout and account deletion leaving every Hermes fixture hash unchanged.

Also run malicious callback cases for wrong state, wrong PKCE, replayed code, altered device signature, and redirect URI outside the exact loopback structure.

**Step 3: Verify the E2E test is red, then connect only through generated types**

```bash
npm test -- tests/agentera-cloud-contract.test.ts
npx playwright test tests/e2e/agentera-auth.e2e.ts
```

Expected before final wiring: contract test passes, E2E fails at the first unwired integration boundary. Update `client.ts` to consume the generated request/response types, fix only observed contract mismatches, and rerun until green. Do not add a permissive `unknown as` cast or accept undocumented fields.

**Step 4: Run the cloud release gate**

```bash
cd "$CLOUD"
go test ./...
go test -race ./internal/secure ./internal/verification ./internal/account ./internal/oauth ./internal/device ./internal/session ./internal/entitlement ./internal/jobs
cd "$CLOUD/web" && npm ci && npm test -- --run && npm run build && npx playwright test
cd "$CLOUD"
./scripts/check-secrets.sh
docker compose up -d --build
./scripts/smoke-auth.sh
docker compose down -v
git status --short
```

Expected: all gates pass and the cloud worktree is clean.

**Step 5: Run the desktop release gate**

```bash
cd "$DESKTOP"
npm ci
npm run check:agentera-cloud-contract
npm test
npm run typecheck
npm run build
npx playwright test tests/e2e/agentera-auth.e2e.ts
node scripts/agentera-auth-smoke.mjs
git diff --check
git status --short
```

Expected: all automated checks pass; the packaged-development app completes browser callback, Profile binding, offline relaunch, renewal, revoke, and logout; only the ignored/untracked local vector cache may appear.

**Step 6: Run the non-negotiable AgentEra Runtime compatibility gate**

```bash
cd "$RUNTIME"
scripts/run_agentera_compatibility.sh -j 4 -q
git status --short
```

Expected: PASS for Hermes Memory, background review, Profile, skill, and Curator compatibility tests; the Runtime worktree stays unchanged. A desktop-auth success cannot waive a failure here.

**Step 7: Perform platform evidence checks**

On the current macOS machine, launch the packaged app and manually record screenshots/log references for registration, callback, existing-data claim, offline mode, renewal, device revoke, logout, and account-deletion warning. Verify Keychain-backed storage with no plaintext credentials in `userData`.

Extend desktop CI to run contract, unit, typecheck, and build jobs on macOS, Windows, and Linux. Before a public commercial release, run a physical or VM smoke test on Windows and Linux; CI compilation alone is not sufficient evidence for secure storage, loopback firewall behavior, or system-browser return.

**Step 8: Write an evidence-based release-state report**

In `docs/release/agentera-app-authentication-verification.md`, record commit SHAs for both repositories, pinned contract SHA-256, every command/result, platform evidence, outstanding infrastructure gates, and one of these exact states:

- `DEVELOPMENT_COMPLETE`: code, tests, and macOS flow pass.
- `MERGE_READY`: required review, CI, security checks, and Runtime compatibility all pass.
- `PUBLIC_RELEASE_READY`: filed domain, trusted HTTPS, real mail/SMS, legal pages, encrypted restore drill, and Windows/Linux smoke all pass.

Never label code-only completion as public commercial readiness.

**Step 9: Commit integration evidence**

```bash
cd "$DESKTOP"
git add contracts src/shared/agentera-cloud-api.generated.ts src/main/agentera-auth/client.ts scripts tests/e2e tests/agentera-cloud-contract.test.ts docs/release package.json package-lock.json .github/workflows/ci.yml
git commit -m "test: verify AgentEra authentication integration"
git status --short --branch
```

Expected: the desktop branch contains intentional source, tests, and evidence only; `lat.md/.cache/vectors.db` remains untracked and unstaged. Stop for final review. Pushing, opening PRs, merging, deploying private staging, or changing production infrastructure each requires the user’s explicit authorization.

## Plan completion checklist

Before declaring implementation complete, verify every item below from fresh processes and isolated data directories:

- Splash always precedes AgentEra product authentication; Runtime installation occurs only after authentication; setup/main occurs only after ownership binding.
- Email or mainland phone registration, password login, verification, recovery, optional second identity, personal-space creation, device management, and self-service deletion work through the browser account center.
- The desktop callback uses exact loopback redirect, PKCE, state, one-time code, and device proof; secrets remain main-process-only and encrypted at rest.
- Five concurrent active devices cannot be exceeded; refresh replay revokes the family; online revocation blocks new tasks.
- Each successful online validation grants a new seven-day offline window; valid offline access preserves local Hermes execution and learning; expiry has no bypass.
- Existing local data is bound only after explicit choice and never copied, rewritten, deleted, or uploaded; a fresh Profile is created with `cloneFrom === null`.
- Local, remote, and SSH use all require AgentEra authentication plus the matching owner context; AgentEra tokens never reach Runtime processes.
- Recharge-site account, cookies, IDs, tokens, balance, and API keys remain independent; the recharge button is still a plain external navigation.
- Cloud database/role, Redis ACL/namespace, origin, cookie, encryption, HMAC, access-signing, and offline-signing keys are independent from other products.
- Cloud, desktop, cross-repository, security, build, macOS, Windows/Linux CI, backup/restore, and Runtime compatibility evidence is recorded without overstating readiness.
