# Internal Beta Live Smoke

This is the only order that may produce `INTERNAL_BETA_ACCEPTED`. It binds the
deployed Cloud/Admin digests and the installed Mac/Windows bytes to one
canonical, content-free evidence record. A partial run remains in the external
operator record and is never renamed acceptance.

SMTP and SMS are absent. Registration uses the isolated `internal_beta` direct
mode, stores an email-shaped identifier as unverified, and must tell the tester
that password recovery is unavailable.

## 1. Freeze immutable inputs

Before inviting a tester, record and reverify:

- exact merged Desktop, Cloud, Admin, and unchanged Runtime SHAs;
- successful exact-SHA main CI run URLs;
- Cloud/Admin candidate workflow URLs and canonical manifest hashes;
- immutable GHCR `@sha256` image digests and Sigstore verification;
- the Desktop internal-Beta workflow URL and manifest/provenance Sigstore
  verification;
- all four package names, sizes, and SHA-256 values; and
- the deployed issuer, offline-entitlement key ID/public key, and Runtime lock.

Never use a tag, branch name, `latest`, package copied from another workflow, or
manifest reconstructed after the build.

## 2. Verify public HTTPS and private Admin

Confirm the public certificate chain and exact IP identity through an ordinary
client trust store. Its expiry must be more than 24 hours after acceptance and
no more than eight days after acceptance. Then check:

```sh
curl --fail --silent --show-error --proto '=https' \
  BETA_ORIGIN/health/live
curl --fail --silent --show-error --proto '=https' \
  BETA_ORIGIN/health/ready
```

Run the Cloud exposure check on the host. Only SSH, ACME HTTP, and Cloud HTTPS
may be public. Open Admin through the reviewed SSH loopback tunnel and run its
health plus Cloud mTLS/service-JWT read-only smoke. Do not publish Admin through
Caddy.

Confirm recorded deployment state matches both candidate digests and reports:

- `registrationMode=direct`;
- public registration, Official Agents, quality, and encrypted backup enabled;
- Admin mutations disabled; and
- no public PostgreSQL, Redis, MinIO, Internal Admin, Docker, or Admin listener.

## 3. Verify package bytes before opening

The downloaded `internal-beta-manifest.json` is authoritative. Reverify its
Cosign bundle and the exact GitHub Actions OIDC workflow identity before
checking local bytes.

On macOS:

```sh
shasum -a 256 Aera-Internal-Beta-*-macos-arm64.dmg
shasum -a 256 Aera-Internal-Beta-*-macos-arm64.zip
```

On Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\Aera-Internal-Beta-*-windows-x64-setup.exe
Get-FileHash -Algorithm SHA256 .\Aera-Internal-Beta-*-windows-x64-portable.exe
```

Every printed hash must exactly equal the manifest. A mismatch stops the run;
do not redownload from an unrecorded source or edit the evidence.

The live validator rehashes the four package files again:

```sh
node scripts/internal-beta/verify-live-evidence.mjs \
  --evidence INTERNAL_BETA_EVIDENCE_JSON \
  --desktop-manifest INTERNAL_BETA_MANIFEST_JSON \
  --cloud-manifest CLOUD_CANDIDATE_MANIFEST_JSON \
  --admin-manifest ADMIN_CANDIDATE_MANIFEST_JSON \
  --artifacts EXACT_PACKAGE_DIRECTORY
```

## 4. Install the unsigned internal-only packages

These packages deliberately make no Developer ID, notarization, Authenticode,
or SmartScreen-reputation claim.

For macOS, first run the SHA-256 check. An unidentified-developer Gatekeeper
warning is expected. Use Finder's one-time **Open** action or the matching
**Privacy & Security → Open Anyway** action only for the exact verified DMG.
Never disable Gatekeeper globally, remove quarantine recursively, or reuse an
override for bytes with another hash.

For Windows, first run the SHA-256 check. An unknown-publisher or SmartScreen
warning is expected. Use **More info → Run anyway** only for the exact verified
installer. Never disable SmartScreen, lower organization policy, or describe
the executable as Authenticode-signed.

Record only the coarse roles `macos_arm64` and `windows_x64`, coarse versions
such as `macOS 15` or `Windows 11`, the installed package role, and its hash. Do
not record a device identifier, username, hostname, filesystem path, or
screenshot containing personal data.

## 5. Register, sign in, and prove offline binding

Execute in this order:

1. Register one internal test identifier through direct mode.
2. Confirm the UI explicitly says mailbox ownership is unverified and recovery
   is unavailable.
3. Complete Desktop OAuth sign-in.
4. Confirm the returned offline entitlement uses the exact reviewed issuer and
   key ID/public key.
5. Disconnect networking for a bounded interval and confirm entitled local use.
6. Reconnect and separately prove that wrong issuer, unknown key, changed
   signature, and wrong installation/device binding are rejected.

Handle the identifier, password, OAuth values, device key, and entitlement only
inside the live test systems. None may enter evidence, terminal output,
screenshots, issue text, or the operator record.

## 6. Run one Official Agent turn and quality modes

Install the selected Official Agent and complete one ordinary turn on each
platform. Evidence records only `officialAgentInstall=passed` and
`officialAgentTurn=passed`; it never stores the prompt, response, Session,
Profile, RuntimeBinding, Memory, Skill, token, or filesystem location.

With quality consent off, confirm no event is uploaded. Turn consent on and
confirm only the fixed result/timing/token/crash buckets are accepted. Do not
use prompt/response text as quality proof.

## 7. Exercise encrypted backup and migration

Use a disposable internal test Profile with no real credential or company
secret:

1. Create one encrypted backup.
2. Interrupt an upload and confirm the same upload resumes.
3. Restore on the second authorized platform/device.
4. Confirm tampered ciphertext is rejected without changing the destination.
5. Confirm a wrong recovery phrase is rejected.
6. Revoke a device and confirm it can no longer restore.

The recovery phrase is displayed only to the tester and is never copied into
evidence, logs, screenshots, chat, issue trackers, or the operator directory.
Evidence stores only fixed passed/rejected outcomes.

## 8. Restart, sign out, and reinstall

Restart the application, then sign out and back in. Uninstall and reinstall the
same exact package bytes. Confirm the expected local Profile/learning ownership
and Runtime binding remain stable, while account credentials and offline
entitlement follow the documented sign-out rules.

Run Cloud/Admin health and exposure checks again after a host reboot. Recheck
the certificate renewal timer and exact deployment digests.

## 9. Create canonical acceptance evidence

Create only the fields allowed by
`release/internal-beta-evidence.schema.json`. Every fixed outcome must be
`passed`; unknown fields are rejected. In particular, do not add:

- passwords, tokens, private keys, email addresses, or recovery phrases;
- raw account, device, installation, Profile, Session, or backup identifiers;
- prompts, responses, Agent content, Memory, Skills, or error text;
- local paths, screenshots, arbitrary notes, or raw logs.

Canonicalize using the same recursive key ordering as the internal-Beta
manifest. The validator checks the schema closure, all exact source/candidate
identities, candidate-manifest hashes, image digests, Runtime lock, certificate
window, direct mode, Mac/Windows roles, all rejection scenarios, and the bytes
of every package.

Only a successful validator result for the complete record changes the release
status to `INTERNAL_BETA_ACCEPTED`. Any failure remains a precise failed or
pending gate; it does not erase already valid evidence.
