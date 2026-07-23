# Aera Internal Beta Delivery Design

**Date:** 2026-07-24

**Status:** Approved design, amended to defer SMTP

**Coordinator repository:** `bignormal/aera`

## Goal

Deliver one usable internal Beta to trusted company testers on Apple Silicon macOS
and Windows 11 x64. Testers must be able to install Aera, register without an
account-count cap, sign in, use an Agent, submit quality feedback, create an
encrypted backup, and restore or migrate it on another authorized device.

This work turns already-merged and remotely verified code into a real deployed
system. It is not a public release, GitHub Release, production rollout, or claim
that every later release gate has passed.

## Immutable starting point

Implementation starts from fresh worktrees based on these remote `main`
checkpoints:

- Desktop: `47e1ef0b8eb4d5395f7dd26217422438a4dae949`
- Cloud: `7b0337d64e50bbcbfb7c0d20981bdf140a8ecba6`
- Admin: `edbf6f790518d1e2d22db57c7583f6fe92c6f813`
- Runtime Seed source, unchanged:
  `c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb`

Later implementation commits and CI runs become the exact Beta source
identities. Passing old runs may establish the baseline but cannot prove later
changes.

## Approved delivery scope

The delivery has four user-visible outcomes:

1. Deploy Cloud and Admin to the authorized Alibaba Cloud ECS host.
2. Configure the temporary HTTPS IP origin and independently generated service
   keys.
3. Produce installable macOS arm64 and Windows x64 internal-Beta packages bound
   to that Cloud origin.
4. Complete a live-server smoke covering registration, login, Agent execution,
   quality feedback, encrypted backup, and cross-device restore or migration.

Three P0 closure items are part of those outcomes rather than separate projects:

- complete the Beta issuer and offline-entitlement trust chain;
- make the explicitly isolated internal-Beta direct-registration path
  operational while SMTP is unavailable;
- explicitly approve and verify the pinned Runtime Seed candidate for internal
  Beta use.

## Explicit non-goals

This delivery does not wait for or claim:

- ICP filing completion or the final product domain;
- unrestricted public marketing or external-user availability;
- payment or recharge-provider launch;
- a release tag, GitHub Release, updater publication, or production rollout;
- Apple notarization or Windows Authenticode when credentials are unavailable;
- the four-device production acceptance matrix or the full production rollback
  rehearsal.

The work must not modify `aera-runtime`, transfer ownership of Hermes Profiles,
upload private Memory or Skills, or weaken backup cryptography.

## Deployment architecture

The authorized ECS host runs one isolated internal-Beta stack:

- a reverse proxy terminates trusted HTTPS for the temporary public IP;
- the Cloud public/account listener is the only application listener exposed
  through the reverse proxy;
- Admin remains loopback-only for browser access;
- the Cloud Internal Admin listener is reachable only from Admin on a private
  container network and requires both mTLS and a scoped service JWT;
- Cloud and Admin use separate PostgreSQL databases/roles and Redis
  credentials/namespaces;
- encrypted-backup object storage has no public listener and stores ciphertext
  only;
- database, Redis, object-storage, Internal Admin, and container-management
  ports are never exposed to the Internet.

Registration has no application account-count cap, IP allowlist, invitation
code, or VPN requirement. The endpoint is labelled and operated as an internal
Beta and is not advertised as a public service. Existing password policy,
session revocation, rate limits, audit redaction, and fail-closed authorization
remain enabled.

The exact host address and all secret values stay in the external deployment
record, never in Git or workflow artifacts.

## Temporary HTTPS IP origin

The external deployment record defines `AERA_INTERNAL_BETA_ORIGIN` as the exact
canonical HTTPS origin for the authorized public IP. A publicly-trusted,
short-lived IP certificate is requested and renewed automatically. Renewal
failure alerts before expiry and prevents an expired certificate from being
treated as healthy.

Port 80 is used only for ACME validation and redirects ordinary traffic to
HTTPS. Port 443 terminates TLS. The application listener remains bound to
loopback behind the reverse proxy.

When the filed domain becomes available, it is a new issuer ceremony. The
Desktop trust map and Cloud signing configuration receive the new exact issuer;
Beta IP sessions and offline entitlements are revoked or allowed to expire, and
testers sign in again. The system never silently rewrites an existing issuer.

## Beta authentication trust chain

Implementation generates an independent Ed25519 offline-entitlement key pair
and key ID for the IP-based Beta issuer:

- the private key exists only in the Cloud secret directory with owner-only
  permissions;
- the public key and exact issuer are added to the Desktop issuer-scoped trust
  map;
- the Desktop Beta build injects the exact Cloud origin at build time;
- online token acceptance must validate the returned offline entitlement
  against that issuer and public key before persisting the session;
- a wrong issuer, unknown key ID, changed binding, invalid signature, or expired
  entitlement fails closed.

The Beta private key is not reused for the final domain or production.

## Registration while SMTP is deferred

The first internal Beta uses email-shaped login identifiers and passwords
without claiming that mailbox ownership was verified. This direct-registration
mode is an explicit, fail-closed `internal_beta` capability:

- it is disabled unless both public registration and direct registration are
  explicitly enabled;
- it cannot start in `production`;
- the identity is stored as unverified and the account center explains that
  password reset, identity binding, deletion recovery, and other
  verification-dependent flows are unavailable until a real provider exists;
- the UI sends the entered normalized identity only to the registration API and
  never offers a verification-code control;
- registration and login rate limits remain active;
- no code, magic link, provider placeholder, log output, or Admin backdoor is
  used to simulate verification.

Phone/SMS registration is disabled. When a real SMTP service is added later,
the deployment switches back to verified registration and requires the
unverified Beta identity to be verified or replaced before recovery-dependent
features are enabled.

Direct registration uses a bounded Redis-backed request limit per pseudonymous
remote-IP key. Redis failure rejects the registration, and neither the raw IP
nor the login identifier is stored in the limiter.

## Supply-chain evidence and deployment identity

Cloud and Admin are built once from exact successful-CI SHAs and deployed only
by `image@sha256:...`. Because GitHub Artifact Attestations are unavailable for
the private user-owned repositories, candidate evidence uses the already
approved Cosign/Sigstore OIDC path:

- keyless image signature;
- signed in-toto provenance bound to the image digest and source SHA;
- SPDX SBOM and its digest;
- canonical candidate manifest with source, CI run, image, provenance, SBOM,
  migration range, and compatibility fields;
- verification of the expected GitHub OIDC issuer and workflow identity before
  deployment.

No valid manifest means no deployment. Staging and production later promote the
same bytes, but this internal Beta does not claim production acceptance.

## Desktop internal-Beta packages

A dedicated internal-Beta workflow builds macOS arm64 and Windows x64 from the
exact successful Desktop CI SHA. Both builds:

- prepare and verify the locked Runtime Seed candidate;
- inject the temporary Cloud HTTPS origin and Beta public trust root;
- produce deterministic filenames, sizes, and SHA-256 checksums;
- emit SBOM/provenance and an OIDC-signed Beta manifest;
- create no tag, GitHub Release, or updater publication.

When Apple or Windows signing credentials are unavailable, the workflow emits
clearly labelled internal-only packages. Trusted testers follow documented
Gatekeeper or SmartScreen override steps and verify the SHA-256 checksum before
installation. An unsigned package must never be relabelled as production-ready.

The Runtime Seed candidate is approved only for this internal Beta. Its tag,
source commit, platform archive, manifest, and signature must match the lock
file on both platforms. No Runtime source change is permitted.

## Live-server validation

The handoff gate requires successful observations against the deployed HTTPS IP
origin, not local mocks:

1. health and version checks identify the exact Cloud and Admin digests;
2. a tester creates an explicitly unverified internal-Beta login identifier,
   registration completes, and login returns an offline entitlement accepted by
   Desktop;
3. one Apple Silicon Mac and one Windows 11 x64 device install the exact Beta
   packages and launch successfully;
4. a real Agent turn succeeds without changing USER-owned Profile or
   RuntimeBinding ownership;
5. quality consent off sends nothing, consent on sends only the minimized
   approved envelope, and chat remains usable on delivery failure;
6. one device creates an encrypted backup, upload interruption can resume, and
   another authorized device restores or migrates into a fresh Profile;
7. wrong recovery material, corrupted ciphertext, and a revoked device fail
   without replacing the usable Profile;
8. restart, sign-out/sign-in, and basic uninstall/reinstall behavior are
   observed on both operating systems.

Evidence retains only exact SHAs/digests, package hashes, coarse platform
versions, timestamps, fixed outcomes, and redacted logs. It excludes passwords,
tokens, verification codes, recovery words, keys, emails, prompts, responses,
Memory, Skills, filenames, and local Profile paths.

## Failure and rollback behavior

- A missing or invalid signature, manifest, issuer key, TLS certificate,
  provider credential, backup, or restore check stops the affected handoff.
- Cloud deploys before Admin; both start with new feature flags or Admin
  mutations disabled, pass health checks, and then enable the approved internal
  Beta functions.
- Application rollback uses the recorded previous exact digest only when schema
  compatibility permits. It never runs a down migration or deletes new data.
- A failed Desktop package is withdrawn from the internal handoff. It is
  replaced by a higher reviewed Beta build rather than silently swapping bytes
  under the same filename or checksum.
- A later domain migration is treated as a new issuer and requires tester
  reauthentication.

## Server access and secret handling

The password previously posted in chat is treated as exposed. Before
installation:

1. rotate the password through the cloud console;
2. install a temporary SSH public key for deployment;
3. disable password SSH authentication after key access is verified;
4. retain a console recovery path;
5. generate every application, database, Redis, mTLS, JWT, HMAC, encryption,
   and signing secret independently on the host;
6. store secrets outside repositories, images, command output, and workflow
   artifacts.

## Completion definition

The internal Beta is complete only when all of the following exist:

- exact Cloud, Admin, Desktop, and Runtime identities;
- verified Cloud/Admin candidate manifests and deployed digests;
- healthy HTTPS IP endpoint with automated certificate renewal;
- functioning direct internal-Beta registration and Desktop login trust chain;
- installable, checksummed macOS and Windows internal-Beta packages;
- successful live Mac/Windows smoke for Agent, quality feedback, encrypted
  backup, and cross-device restore or migration;
- a concise tester handoff containing access URL, package links, checksums,
  expected installation warnings, known Beta limitations, and issue-reporting
  instructions.

Deployment, internal-Beta acceptance, public release, and production readiness
remain separately reported states.
