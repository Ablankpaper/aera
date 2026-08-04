# Beta.23 Internal Beta Unsigned Windows Exception

**Status:** Approved in conversation on 2026-08-04

## Context

Beta.21 shipped a Developer-ID-signed and notarized macOS build together with an explicitly unsigned Windows x64 setup and portable build. Beta.23 briefly changed the Internal Beta workflow to require Windows Authenticode, but no trusted Windows certificate or cloud-signing account is available.

The approved temporary decision is to ship the Beta.23 `internal-beta` Windows packages unsigned, matching the Beta.21 platform-signing boundary. This exception does not weaken the production candidate workflow or claim that Windows has a trusted publisher identity.

## Scope

The change applies only to the Desktop `0.7.4-internal-beta.23` candidate and promotion workflows.

- macOS remains Developer ID signed, Apple-notarized, stapled, and Gatekeeper-accepted.
- Windows x64 NSIS setup and portable packages are deliberately unsigned.
- Windows packages still require exact filenames, x64 packaging, locked Runtime Seed verification, SHA-256/SHA-512 binding, signed update metadata, and immutable online publication.
- The production `release-candidate.yml` Authenticode requirement remains unchanged.
- Linux and other platforms remain outside the product build, release, and real-device acceptance scope.

Cloud signing, certificate procurement, SmartScreen reputation building, and a general signing platform are not part of this exception.

## Workflow and Evidence Design

The Windows `internal-beta.yml` job restores the Beta.21 packaging contract: it disables code-signing identity discovery, builds NSIS and portable x64 packages with `forceCodeSigning: false`, verifies the packaged Runtime Seed, and stages the exact bytes without Authenticode evidence.

The canonical Internal Beta manifest identifies the candidate as `macos_developer_id_notarized_windows_unsigned`. It removes `windows-evidence.json` from the required supply-chain object while continuing to hash-bind both Windows artifacts and the Windows Runtime Seed manifest.

The update manifest remains Ed25519-signed and binds each downloadable artifact's platform, architecture, size, SHA-256, and SHA-512. That protects update-channel integrity but is not presented as a Windows publisher signature.

The promotion workflow continues to publish only the already-built candidate bytes. It does not rebuild, sign, or replace artifacts under the same immutable version.

## Failure and User-Visible Behavior

Packaging fails when the Windows artifacts, x64 identity, Runtime Seed, update signature, or hashes are missing or inconsistent. Missing Authenticode credentials do not fail this temporary Internal Beta path because they are intentionally unused.

Windows may show an unknown-publisher or SmartScreen warning. Acceptance records must label the package as unsigned, and testers must not disable SmartScreen, antivirus, or other system-wide protections. A Windows Authenticode check is expected to report no trusted publisher and is not counted as a failed implementation of this approved exception.

## Verification and Release Boundary

Focused policy and manifest tests will prove all of the following:

- the Internal Beta Windows job cannot silently attempt certificate discovery or require `WIN_CSC_*` secrets;
- the Internal Beta manifest explicitly records `windows_unsigned` and rejects unexpected Windows signing evidence;
- Runtime Seed, artifact digest, architecture, update-signature, and immutable-promotion checks remain required;
- the production release-candidate workflow still fails closed without Authenticode.

The implementation uses one reviewable PR, one exact-head CI run, and one merged-main CI run. No local full-repository gate is added.

Candidate run `30883414444` remains permanently isolated and cannot be promoted or reused. A new Beta.23 candidate must be built once from the final merged-main SHA, with a newly notarized macOS package and newly built unsigned Windows packages.

Real acceptance remains a separate evidence layer: isolated Beta.21-to-Beta.23 online update on macOS and Windows, Runtime `.1` to stable `.3` update, affected Agent/Runtime recovery paths, and the agreed minimum business-flow regression. CI and candidate assembly do not substitute for real-device acceptance.

## Future Reversal

A future reviewed version may introduce Microsoft Artifact Signing or another approved managed Authenticode service. That work must use a new immutable version and restore trusted Windows publisher verification; it must not replace the published Beta.23 bytes.
