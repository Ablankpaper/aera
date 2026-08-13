# Organization Cloud Schema Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Cloud contract required by Desktop Beta.25 without lying about migration 22 or losing a schema-compatible rollback target.

**Architecture:** Build two immutable candidates from one exact temporary Git ref. The first keeps the deployed application code and truthfully promises compatibility through schema 22 while still carrying only migrations through 21; after it is deployed, the same ref incorporates the reviewed `aba165d` source and truthfully advances the highest migration to 22.

**Tech Stack:** Go 1.24, PostgreSQL 17, Redis 7.4, Bash, Docker Compose, GitHub Actions, GHCR, Cosign/Sigstore.

---

### Task 1: Make the bridge manifest contract fail first

**Files:**

- Modify: `.github/workflows/candidate.yml`
- Modify: `scripts/tests/delivery-contract.test.sh`

- [ ] **Step 1: Change only the bridge assertion**

In `scripts/tests/delivery-contract.test.sh`, require the exact bridge pair:

```bash
require_text .github/workflows/candidate.yml 'AERA_RELEASE_SCHEMA_MAX: "22"'
require_text .github/workflows/candidate.yml 'AERA_RELEASE_HIGHEST_MIGRATION: "21"'
```

- [ ] **Step 2: Run the assertion and verify RED**

Run: `bash scripts/tests/delivery-contract.test.sh`

Expected: FAIL because `candidate.yml` still contains `AERA_RELEASE_SCHEMA_MAX: "21"`.

- [ ] **Step 3: Make the minimal bridge change**

In `.github/workflows/candidate.yml`, set:

```yaml
AERA_RELEASE_SCHEMA_MIN: "17"
AERA_RELEASE_SCHEMA_MAX: "22"
AERA_RELEASE_HIGHEST_MIGRATION: "21"
```

- [ ] **Step 4: Verify GREEN**

Run: `bash scripts/tests/delivery-contract.test.sh`

Expected: `delivery contract tests passed`.

### Task 2: Add a reproducible schema-22 compatibility proof

**Files:**

- Create: `scripts/tests/schema-22-compatibility.test.sh`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the pinned compatibility test**

Create an executable Bash test that:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
migration_source_sha=aba165d256cd447abcd43ce4c397041c2bf802d1
migration_sha256=f02358bdacd540f92f5977a24a7ef5568de3354803e436ce966699a5433e6fd7
migration_name=000022_organization_experience_candidates.sql
tmp_root=$(mktemp -d -t aera-schema22-compat)
project="aera-schema22-compat-$$"
compose=(docker compose -p "$project")

cleanup() {
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$tmp_root"
}
trap cleanup EXIT

for command_name in curl docker go shasum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'schema 22 compatibility test: %s is required\n' "$command_name" >&2
    exit 1
  }
done

migration_file="$tmp_root/$migration_name"
if [[ -n ${AERA_SCHEMA22_MIGRATION_FILE:-} ]]; then
  cp "$AERA_SCHEMA22_MIGRATION_FILE" "$migration_file"
else
  curl --fail --silent --show-error --location \
    "https://raw.githubusercontent.com/Ablankpaper/aera-cloud/$migration_source_sha/migrations/$migration_name" \
    --output "$migration_file"
fi
[[ $(shasum -a 256 "$migration_file" | awk '{print $1}') == "$migration_sha256" ]]

AERA_CLOUD_POSTGRES_BIND='127.0.0.1:' \
AERA_CLOUD_REDIS_BIND='127.0.0.1:' \
  "${compose[@]}" up -d --wait postgres redis
postgres_address=$("${compose[@]}" port postgres 5432)
redis_address=$("${compose[@]}" port redis 6379)
set -a
source "$repo_root/.env.example"
set +a
export AGENTERA_CLOUD_DATABASE_URL="postgres://aera_cloud:aera-cloud-dev-only@$postgres_address/aera_cloud?sslmode=disable"
export AGENTERA_CLOUD_REDIS_ADDR="$redis_address"
export AERA_INTEGRATION_TESTS=1

go test -count=1 ./internal/store -run '^TestApplyMigrationsCreatesAuthSchemaAndIsIdempotent$'
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U aera_cloud -d aera_cloud -1 <"$migration_file"
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U aera_cloud -d aera_cloud \
  -v migration_checksum="$migration_sha256" -c \
  "INSERT INTO schema_migrations (version, name, checksum) VALUES (22, '$migration_name', decode(:'migration_checksum', 'hex'))"
[[ $("${compose[@]}" exec -T postgres psql -At -U aera_cloud -d aera_cloud -c 'SELECT max(version) FROM schema_migrations') == 22 ]]

go test -count=1 -p 1 ./internal/account ./internal/organization ./internal/agentcontrol
go test -count=1 ./cmd/aera-cloud -run '^TestSmokeAuthLifecycle$'
CGO_ENABLED=0 go build -trimpath -o "$tmp_root/aera-cloud" ./cmd/aera-cloud
printf 'schema 22 compatibility passed: bridge=%s migration-source=%s highest=22\n' \
  "$(git rev-parse HEAD)" "$migration_source_sha"
```

- [ ] **Step 2: Make the script executable and syntax-check it**

Run: `chmod +x scripts/tests/schema-22-compatibility.test.sh && bash -n scripts/tests/schema-22-compatibility.test.sh`

Expected: exit 0 with no output.

- [ ] **Step 3: Add the compatibility gate to CI**

Add this step after the ordinary service integration step in `.github/workflows/ci.yml`:

```yaml
- name: Prove deployed application compatibility with schema 22
  run: bash scripts/tests/schema-22-compatibility.test.sh
```

- [ ] **Step 4: Run the proof using the exact reviewed local migration**

Run:

```bash
AERA_SCHEMA22_MIGRATION_FILE=/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/organization-contract-recovery-cloud/migrations/000022_organization_experience_candidates.sql \
  bash scripts/tests/schema-22-compatibility.test.sh
```

Expected: selected old-application repository tests and `TestSmokeAuthLifecycle` pass, the binary builds, and the final line reports `highest=22`.

### Task 3: Verify and freeze the bridge source

**Files:**

- Verify: `.github/workflows/candidate.yml`
- Verify: `.github/workflows/ci.yml`
- Verify: `scripts/tests/delivery-contract.test.sh`
- Verify: `scripts/tests/schema-22-compatibility.test.sh`

- [ ] **Step 1: Run bridge release gates**

Run:

```bash
bash scripts/tests/check-secrets.test.sh
bash scripts/tests/delivery-contract.test.sh
bash scripts/tests/provenance.test.sh
bash scripts/tests/release-manifest.test.sh
./scripts/check-secrets.sh
go test -count=1 ./...
go vet ./...
```

Expected: every command exits 0.

- [ ] **Step 2: Verify diff hygiene**

Run: `git diff --check && git status --short`

Expected: only the four bridge files are modified or new.

- [ ] **Step 3: Commit the bridge**

Run:

```bash
git add .github/workflows/candidate.yml .github/workflows/ci.yml scripts/tests/delivery-contract.test.sh scripts/tests/schema-22-compatibility.test.sh
git commit -m "fix(release): bridge cloud schema 22 compatibility"
```

Expected: one commit whose parent is `1d2fbc99662bdfc10d4ff3669c7eb47d63dc2034`.

### Task 4: Build, verify, and deploy the bridge candidate

**Files:**

- Operational evidence only; no repository edits.

- [ ] **Step 1: Push the exact temporary ref and wait for exact-head CI**

Run:

```bash
git push -u origin aera/schema22-compatibility-bridge
bridge_sha=$(git rev-parse HEAD)
gh run list --workflow ci.yml --branch aera/schema22-compatibility-bridge --json databaseId,headSha,conclusion,status \
  --jq ".[] | select(.headSha == \"$bridge_sha\")"
```

Expected: one exact-head CI run reaches `conclusion=success`.

- [ ] **Step 2: Dispatch and download the exact candidate**

Run:

```bash
bridge_ci_run=$(gh run list --workflow ci.yml --branch aera/schema22-compatibility-bridge --json databaseId,headSha,conclusion \
  --jq ".[] | select(.headSha == \"$bridge_sha\" and .conclusion == \"success\") | .databaseId" | head -n 1)
gh workflow run candidate.yml --ref aera/schema22-compatibility-bridge -f source_sha="$bridge_sha" -f ci_run_id="$bridge_ci_run"
```

Expected: the candidate workflow succeeds for the exact bridge SHA and emits a signed manifest with maximum 22 and highest migration 21.

- [ ] **Step 3: Deploy disabled with the exact branch workflow identity**

From the established owner-controlled internal-beta host shell, set the certificate identity to exactly `refs/heads/aera/schema22-compatibility-bridge`, set `AERA_INTERNAL_BETA_EXPECTED_SHA` to the verified bridge SHA, and run the checked-in `deploy.sh deploy` command against the downloaded bridge manifest. Do not enable features on the bridge.

Expected: health, smoke, exposure, current-manifest persistence, and disabled feature checks pass; the database ledger remains at 21.

### Task 5: Advance the same ref to the truthful recovery candidate

**Files:**

- Modify: `.github/workflows/candidate.yml`
- Modify: `scripts/tests/delivery-contract.test.sh`

- [ ] **Step 1: Incorporate the reviewed functional source after bridge deployment**

Run: `git merge --no-ff origin/main -m "merge: add organization cloud contract recovery"`

Expected: the branch contains `aba165d256cd447abcd43ce4c397041c2bf802d1`; retain maximum 22 during conflict resolution.

- [ ] **Step 2: Change the recovery assertion and verify RED**

Change the delivery test to require `AERA_RELEASE_HIGHEST_MIGRATION: "22"`, then run `bash scripts/tests/delivery-contract.test.sh`.

Expected: FAIL while the workflow still declares highest migration 21.

- [ ] **Step 3: Make the truthful recovery change and verify GREEN**

Set the candidate workflow to minimum 17, maximum 22, highest migration 22; rerun `bash scripts/tests/delivery-contract.test.sh`.

Expected: `delivery contract tests passed`.

- [ ] **Step 4: Run full recovery gates and commit**

Run the Task 3 gate commands plus `AERA_INTEGRATION_TESTS=1 go test -count=1 -p 1 ./...` against disposable Compose services, then commit with `fix(release): declare organization schema migration 22`.

Expected: all gates pass and migration 22 is the highest embedded migration.

### Task 6: Deploy and enable the recovery candidate

**Files:**

- Operational evidence only; no repository edits.

- [ ] **Step 1: Push the advanced same ref, wait for exact-head CI, and build a new immutable candidate**

Repeat Task 4 using the new SHA on `aera/schema22-compatibility-bridge`.

Expected: signed manifest maximum 22, highest migration 22, and the same exact workflow identity as the recorded bridge.

- [ ] **Step 2: Deploy the recovery candidate disabled**

Run the checked-in internal-beta deploy command with the exact new SHA and recovery manifest.

Expected: the guard accepts the recorded bridge maximum 22, the application applies migration 22, public live/ready, smoke, and exposure checks pass, and the bridge becomes the recorded previous candidate.

- [ ] **Step 3: Enable the exact recovery digest and run business acceptance**

Run the checked-in `enable` command for the same manifest, then test Organization definitions, publication submissions, own/review ExperienceCandidate lists, and an installed Beta.25 Owner Organization journey without exporting application credentials.

Expected: no 404 on the ExperienceCandidate routes, publication responses include `published_version_id`, and Beta.25 renders the existing Organization catalog.
