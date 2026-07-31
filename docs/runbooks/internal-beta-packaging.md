# Internal Beta Desktop packaging

This runbook creates one checksummed, internal-only Desktop candidate for trusted company testers, signs its dedicated update metadata, and publishes the verified update bytes without creating a tag, GitHub Release, or production-readiness claim.

## Boundary

The dedicated `internal-beta.yml` workflow builds Apple Silicon macOS and Windows x64 packages from one exact Desktop commit whose three-platform `CI` run already succeeded.

The packages are deliberately unsigned when Apple Developer ID/notarization and Windows Authenticode credentials are unavailable. Their manifest and provenance are still keyless-signed by the GitHub Actions workflow through Sigstore. Those evidence signatures do not turn the applications themselves into platform-signed packages.

The separate Desktop update manifest is signed with an offline Ed25519 key whose public half is pinned in the app. This authenticates the exact ZIP/NSIS bytes but likewise does not turn them into platform-signed packages.

## Required protected environment

Create a GitHub environment named `internal-beta`. It contains only these reviewed public variables:

- `AERA_INTERNAL_BETA_ORIGIN`: the exact canonical HTTPS IP Origin, with no path or trailing slash;
- `AERA_INTERNAL_BETA_OFFLINE_KEY_ID`: the stable Beta offline-entitlement key ID;
- `AERA_INTERNAL_BETA_OFFLINE_PUBLIC_KEY`: the canonical unpadded base64url 32-byte Ed25519 public key.
- `AERA_DESKTOP_UPDATE_PUBLISH_HOST`: the exact internal-Beta server IPv4 address.

It also contains these protected secrets:

- `AERA_DESKTOP_UPDATE_SIGNING_PRIVATE_KEY`: the PEM Ed25519 key matching `build/desktop-update-signing-public.pem`;
- `AERA_DESKTOP_UPDATE_PUBLISH_SSH_PRIVATE_KEY`: the key for the forced-command-only `aera-updates` host principal;
- `AERA_DESKTOP_UPDATE_PUBLISH_SSH_KNOWN_HOSTS`: the pinned SSH host key line.

The Origin is injected as `MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL`. The workflow constructs `MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON` from the same Origin and public key. [[src/main/agentera-auth/config.ts#parseAgenteraOfflinePublicKeysBuildConfig]] rejects any difference.

The Cloud offline-entitlement private key is never a GitHub variable or secret. The workflow may use the existing read-only cross-repository token to download the locked private Runtime release; it never checks out Runtime source.

## Dispatch

Use the merged Desktop `main` SHA and its successful `CI` run ID:

```bash
gh workflow run internal-beta.yml \
  --repo bignormal/aera \
  --ref main \
  -f source_sha=0123456789abcdef0123456789abcdef01234567 \
  -f ci_run_id=30100000001
```

The workflow refuses a non-`main` workflow identity, a source mismatch, a failed or incomplete CI matrix, a version other than `0.7.4-internal-beta.13`, malformed public trust, or an unapproved Runtime Seed lock.

## Built bytes

The platform jobs prepare and independently verify Runtime Seed candidate `dcb0f0bc6a0e2d18c55beedc6517dbc41d8b01e0` (`runtime-v0.18.2-agentera.1-rc.4`), rebuild native modules for the target architecture, compile the baked Beta trust, and package:

- `Aera-Internal-Beta-0.7.4-internal-beta.13-macos-arm64.dmg`
- `Aera-Internal-Beta-0.7.4-internal-beta.13-macos-arm64.zip`
- `Aera-Internal-Beta-0.7.4-internal-beta.13-windows-x64-setup.exe`
- `Aera-Internal-Beta-0.7.4-internal-beta.13-windows-x64-portable.exe`

The Electron Builder overlay sets `identity: null`, `notarize: false`, and `forceCodeSigning: false`; the jobs also set `CSC_IDENTITY_AUTO_DISCOVERY=false` and always pass `--publish never`. Hardened Runtime remains enabled in the macOS application, and normal Windows resource metadata remains embedded.

## Evidence layout

The final 30-day Actions artifact is named `desktop-internal-beta-SOURCE_SHA` and contains:

```text
artifacts/
  four immutable packages
desktop-update/
  manifest.json
  manifest.sig
evidence/
  agentera-runtime-seed.lock.json
  internal-beta.spdx.json
  internal-beta.provenance.json
  internal-beta-provenance.cosign.bundle.json
  internal-beta-manifest.cosign.bundle.json
runtime-seed/
  exact Darwin and Windows Runtime manifests
internal-beta-manifest.json
SHA256SUMS
```

[[scripts/internal-beta/manifest.mjs#buildInternalBetaManifest]] binds the exact source and CI run, version, HTTPS IP Origin, offline public trust, Runtime lock and both target identities, all four package sizes and SHA-256 values, SBOM/provenance hashes, unsigned status, and expected Sigstore identity. [[scripts/internal-beta/manifest.mjs#verifyInternalBetaManifestFiles]] re-hashes every referenced byte before signing.

Cosign `v3.0.6` signs the canonical manifest and SLSA v1 provenance as blobs. Verification requires the GitHub OIDC issuer and exact `internal-beta.yml@refs/heads/main` workflow identity. Syft `v1.44.0` creates the SPDX document. GitHub Artifact Attestations are not used.

## Online publication

The assembly job verifies the detached update signature locally, uploads the complete 30-day evidence artifact, and only then streams a four-file tar archive to `aera-updates@AERA_DESKTOP_UPDATE_PUBLISH_HOST`. The host key is pinned and the authorized key must force `scripts/internal-beta/publish-desktop-update.sh`, disable PTY/forwarding, and grant no shell.

The server command verifies canonical metadata, the pinned key ID and Ed25519 signature, both artifact digests and sizes, version monotonicity, and immutable version bytes. A channel-wide file lock serializes the monotonicity check and publish operation. It stores artifacts under `/var/lib/aera/desktop-updates/internal-beta/releases/VERSION`, metadata under `versions/VERSION`, and atomically replaces only the relative `current` symlink. Caddy serves the reviewed path. The workflow fails unless live metadata equals the locally signed bytes and both versioned artifacts answer an HTTPS range probe.

## Operator verification

Download the final artifact without rebuilding:

```bash
gh run download RUN_ID \
  --repo bignormal/aera \
  --name desktop-internal-beta-SOURCE_SHA \
  --dir ./desktop-internal-beta
```

From the downloaded directory:

```bash
sha256sum --check SHA256SUMS

cosign verify-blob \
  --bundle evidence/internal-beta-provenance.cosign.bundle.json \
  --certificate-identity-regexp \
  '^https://github\.com/bignormal/aera/\.github/workflows/internal-beta\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  evidence/internal-beta.provenance.json

cosign verify-blob \
  --bundle evidence/internal-beta-manifest.cosign.bundle.json \
  --certificate-identity-regexp \
  '^https://github\.com/bignormal/aera/\.github/workflows/internal-beta\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  internal-beta-manifest.json
```

Windows testers may verify `SHA256SUMS` with `Get-FileHash -Algorithm SHA256`; the tester handoff records each expected package digest explicitly.

## Handoff limit

Do not distribute a package until its workflow completed every real step and the live operator record binds the same manifest hash, source SHA, CI/build run URLs, Origin, deployed Cloud/Admin digests, and package hashes.

Trusted testers should expect Gatekeeper or SmartScreen warnings. Use only the documented per-package override after checksum verification; never disable Gatekeeper, SmartScreen, antivirus, or system-wide security controls. A failed or replaced package receives a higher reviewed Beta version and new hashes rather than swapped bytes under the same filename.

`0.7.4-internal-beta.6` does not contain the online-update client. Testers must install `0.7.4-internal-beta.7` once through the existing manual handoff; subsequent Internal Beta versions use the signed online channel.
