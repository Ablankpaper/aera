# AgentEra App Authentication Verification

**State:** `DEVELOPMENT_COMPLETE`

**Verified:** 2026-07-18 on macOS 26.5.2 (arm64), Node.js 24.13.0, npm 11.6.2, and Go 1.26.5.

This state means the implementation, automated gates, and the macOS packaged-development flow pass. It does **not** mean the product is merge-ready or ready for a public commercial release.

## Revision and contract anchors

| Component | Branch | Verified revision |
| --- | --- | --- |
| Desktop Tasks 1–13 baseline | `aera/app-authentication` | `7cd521d9ed26e1492b83a4e64a5a40c975f50796` |
| Desktop Task 14 integration | `aera/app-authentication` | `86849cdefddf7f23fc8fc7e5ea6f99ff12467fe2` |
| AgentEra cloud | `aera/app-auth-service` | `72e579a394869fbb87bac8c07a58f0d013d52460` |
| Cloud account-switching fix | `aera/app-auth-service` | `3d6ab85` |
| AgentEra Runtime compatibility gate | `aera/hermes-compatibility-gate` | `9c00e1dfd3eba06a96d6d2dc6e59cc55cf29adb0` |

Pinned OpenAPI SHA-256: `1b8f0021be474ba84bff7fc519858dc6533901844f4d70535878950826ec1193`.

The pinned desktop contract is byte-for-byte identical to `../aera-cloud/api/openapi.yaml`. Generated TypeScript is deterministic and checked for staleness.

## Verified product flow

The Playwright harness starts isolated PostgreSQL and Redis containers, a real AgentEra cloud binary, a test-only SMS/captcha capture service, Chromium, and Electron with isolated `userData` and `HERMES_HOME` directories. It verified:

1. Splash preflight reaches the mandatory product-auth gate.
2. Mainland phone registration and browser OAuth return through an exact loopback callback.
3. A personal-space Profile is explicitly bound before local functionality opens.
4. A synthetic local no-op task is allowed only after authorization.
5. The app relaunches offline under a signed seven-day entitlement.
6. Reconnection renews the offline expiry.
7. Device revocation blocks the desktop and returns it to the auth gate.
8. Same-account re-login preserves the existing Profile binding.
9. Different-account login rejects the old Profile ownership binding.
10. Pending account deletion is reported distinctly from device revocation.
11. Logout removes the product session without changing Hermes data.

The same lifecycle passed both the source-development Electron executable and the unpacked macOS application at:

`dist/mac-arm64/AgentEra Studio.app/Contents/MacOS/AgentEra Studio`

The packaged test also asserted that Electron `safeStorage` was available and that `agentera-auth/state.json` contained encrypted private-key, refresh-token, and offline-entitlement fields rather than plaintext credential fields. The local validation package intentionally skipped distribution signing; production signing and notarization remain release gates.

## Hermes non-interference evidence

The E2E test used only a temporary synthetic Hermes fixture. Before and after registration, Profile binding, online use, offline use, renewal, revocation, account switching, deletion, and logout, SHA-256 hashes remained identical for:

- `.env`
- `MEMORY.md`
- `USER.md`
- `sessions/session.json`
- `files/note.txt`
- `skills/example/SKILL.md`
- `curator/state.json`

No real Hermes Memory, USER, session, file, skill, Curator, Profile, or self-learning data was read, uploaded, rewritten, or deleted.

The Runtime compatibility suite passed 362/362 tests across Memory, system-prompt restoration, background review, Profile isolation, file safety, Skill Manager, Curator, and Curator backup. The Runtime worktree remained clean.

## Gate results

### AgentEra cloud

| Command | Result |
| --- | --- |
| `go test ./...` | Passed |
| `go test -race ./internal/secure ./internal/verification ./internal/account ./internal/oauth ./internal/device ./internal/session ./internal/entitlement ./internal/jobs` | Passed |
| `go vet ./...` | Passed |
| `web: npm ci && npm test -- --run && npm run build` | 3 files / 5 tests passed; build passed |
| `web: npx playwright test` | 8/8 browser tests passed |
| `web: npm audit --json` | 0 vulnerabilities after Vite 7.3.6 patch |
| `./scripts/check-secrets.sh` | Passed |
| `./scripts/smoke-auth.sh` | Isolated Docker lifecycle and recovery verification passed |

### AgentEra desktop

| Command | Result |
| --- | --- |
| `npm ci` | Passed from lock file |
| `npm run check:agentera-cloud-contract` | Passed; pinned SHA shown above |
| `npm test` | 188 files passed; 1,883 passed and 3 skipped |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm run test:e2e:auth` | Source Electron lifecycle passed |
| `AGENTERA_E2E_EXECUTABLE_PATH=... npm run test:e2e:auth` | Unpacked macOS application lifecycle passed |
| `npm run smoke:agentera-auth` | 24 desktop boundary tests plus cloud malicious-case tests passed |
| `npm audit --omit=dev --audit-level=high` | 0 production vulnerabilities |
| Targeted ESLint and Prettier checks | Passed for every Task 14 source/test file |
| `git diff --check` | Passed |

The malicious-case gate explicitly covers wrong OAuth state, wrong PKCE verifier, altered device proof, replayed authorization code, noncanonical encodings, and redirect URIs outside the exact IPv4 loopback structure.

### AgentEra Runtime

| Command | Result |
| --- | --- |
| `scripts/run_agentera_compatibility.sh -j 4 -q` | 362/362 passed; worktree unchanged |

## CI and remaining gates

Desktop CI now runs contract validation, production dependency audit, unit tests, type checking, and builds on `ubuntu-latest`, `macos-latest`, and `windows-latest`. This workflow has been configured locally but has not yet run remotely on this unpushed branch.

The following prevent `MERGE_READY` or `PUBLIC_RELEASE_READY`:

- Required review and remote three-platform CI have not run.
- Physical/VM Windows and Linux smoke tests have not run; compilation alone does not validate secure storage, firewall prompts, or browser return behavior.
- The repository's pre-existing full lint backlog remains: 9 errors and 55 warnings in untouched files. Task 14's targeted lint is clean.
- `npm audit` still reports development-only transitive findings from legacy build-tool dependencies; the packaged production dependency audit is clean.
- The macOS distribution-signing and notarization path still needs a clean release-machine run. The local functional package was intentionally unsigned.
- The filed production domain, trusted HTTPS, real mainland SMS/email delivery, final legal pages, monitoring, and incident procedures are not configured.
- A full encrypted backup/restore disaster-recovery drill and production key-rotation drill remain outstanding.
- Windows/Linux installation, update, uninstall, loopback callback, and offline-mode evidence remains outstanding.

The recharge website remains a separate account system and was not modified or coupled to AgentEra product authentication during this work.
