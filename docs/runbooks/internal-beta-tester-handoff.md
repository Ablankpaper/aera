# Internal Beta Tester Handoff

This build is for two or three trusted company testers on Apple Silicon macOS
and Windows 11 x64. It is unsigned, has no public updater, uses a temporary IP
issuer, and has no email/SMS recovery. It is not an external release.

## Before installation

Obtain the package and `internal-beta-manifest.json` from the single recorded
private GitHub Actions run. Verify the exact SHA-256 value before opening it:

- Mac installs the `macos-arm64.dmg`.
- Windows installs the `windows-x64-setup.exe`.
- The ZIP/portable files are retained for byte verification and controlled
  troubleshooting; do not substitute them for the recorded installed role.

If a hash differs, stop and contact the internal operator. Do not use a package
sent through chat, personal storage, or an unrecorded link.

## Expected one-time warning

On Mac, use Finder **Open** or **Privacy & Security → Open Anyway** only after
the exact hash passes. Do not disable Gatekeeper.

On Windows, use SmartScreen **More info → Run anyway** only after the exact hash
passes. Do not disable SmartScreen. The publisher may appear unknown because
this is an explicitly unsigned internal-only build.

## What to test

Follow the operator's order:

1. register and note that account recovery is unavailable;
2. sign in through the app;
3. install and run the selected Official Agent;
4. try quality consent off, then on;
5. create an encrypted backup and resume one interrupted upload;
6. restore on the second authorized test device;
7. confirm wrong phrase, tampered backup, and revoked-device rejection;
8. restart, sign out/in, then uninstall/reinstall.

Keep the recovery phrase offline and private. Never send it to the operator or
put it in a screenshot, document, ticket, chat, or evidence file.

## Safe feedback

Report the package role/hash and one fixed category:

- installation did not start;
- login failed;
- Agent installation or turn failed;
- quality consent behavior differed;
- backup upload/resume failed;
- restore or rejection behavior differed;
- restart/sign-out/reinstall behavior differed.

Do not attach prompts, responses, conversation content, Profile/Memory/Skill
data, account identifiers, email addresses, device identifiers, recovery
phrases, credentials, local paths, or raw logs. If engineering needs additional
diagnostics, the operator will provide a separate redacted collection step.

## Known internal-Beta limits

- Email ownership is not verified and password recovery is unavailable.
- The Mac and Windows packages are not production-signed.
- The temporary IP certificate is short-lived and must renew automatically.
- A later filed domain requires a new issuer-bound Desktop package.
- There is no tag, GitHub Release, public download, or automatic update channel.

Passing this tester checklist alone is not acceptance. The operator must also
validate exact Cloud/Admin candidates, public/private exposure, certificate
expiry, package bytes, all fixed outcomes, and the canonical live evidence
record.
