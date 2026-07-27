# Internal Beta Desktop packaging

This runbook creates one checksummed, internal-only Desktop candidate for trusted company testers without creating a tag, GitHub Release, updater publication, or production-readiness claim.

## Boundary

The dedicated `internal-beta.yml` workflow builds Apple Silicon macOS and Windows x64 packages from one exact Desktop commit whose three-platform `CI` run already succeeded.

The packages are deliberately unsigned when Apple Developer ID/notarization and Windows Authenticode credentials are unavailable. Their manifest and provenance are still keyless-signed by the GitHub Actions workflow through Sigstore. Those evidence signatures do not turn the applications themselves into platform-signed packages.

SMTP is not a packaging dependency. The deployed Cloud must instead be in the separately implemented `internal_beta` direct-registration mode.

## Required protected environment

Create a GitHub environment named `internal-beta`. It contains only these reviewed public variables:

- `AERA_INTERNAL_BETA_ORIGIN`: the exact canonical HTTPS IP Origin, with no path or trailing slash;
- `AERA_INTERNAL_BETA_OFFLINE_KEY_ID`: the stable Beta offline-entitlement key ID;
- `AERA_INTERNAL_BETA_OFFLINE_PUBLIC_KEY`: the canonical unpadded base64url 32-byte Ed25519 public key.

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

The workflow refuses a non-`main` workflow identity, a source mismatch, a failed or incomplete CI matrix, a version other than `0.7.4-internal-beta.3`, malformed public trust, or an unapproved Runtime Seed lock.

## Built bytes

The platform jobs prepare and independently verify Runtime Seed candidate `cb6908026befd99f1f79a516d3c3e6267c9657ac` (`runtime-v0.18.2-agentera.1-rc.2`), rebuild native modules for the target architecture, compile the baked Beta trust, and package:

- `Aera-Internal-Beta-0.7.4-internal-beta.3-macos-arm64.dmg`
- `Aera-Internal-Beta-0.7.4-internal-beta.3-macos-arm64.zip`
- `Aera-Internal-Beta-0.7.4-internal-beta.3-windows-x64-setup.exe`
- `Aera-Internal-Beta-0.7.4-internal-beta.3-windows-x64-portable.exe`

The Electron Builder overlay sets `identity: null`, `notarize: false`, `signAndEditExecutable: false`, and `forceCodeSigning: false`; the jobs also set `CSC_IDENTITY_AUTO_DISCOVERY=false` and always pass `--publish never`. Hardened Runtime remains enabled in the macOS application.

## Evidence layout

The final 30-day Actions artifact is named `desktop-internal-beta-SOURCE_SHA` and contains:

```text
artifacts/
  four immutable packages
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
