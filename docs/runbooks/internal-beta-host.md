# Internal Beta Host Ceremony

This ceremony prepares one temporary company-internal Beta host. SMTP and SMS
remain absent. Cloud starts with every user-facing feature disabled and later
enables the isolated `internal_beta` direct-registration mode only after the
same exact candidate passes health checks. An email-shaped login identifier is
not treated as proof of mailbox ownership.

The host may expose only the reviewed SSH port, HTTP for ACME, and HTTPS for
Cloud. Admin, PostgreSQL, Redis, MinIO, Docker, and the Cloud Internal Admin
listener remain private or loopback-only. Docker-published ports can bypass
ordinary UFW forwarding rules, so the reviewed Compose files must retain their
explicit loopback bindings; UFW is not a substitute for that check.

## Local operator boundary

Keep these outside every repository and outside Actions artifacts:

- the SSH private key and reviewed `known_hosts` entry;
- `/etc/aera/internal-beta` and all generated environment/key material;
- cloud-console credentials and the rotated recovery password;
- candidate downloads before their signatures are verified;
- the operator record under `/Users/zizimutou/Desktop/aera/.internal-beta-operator`.

The operator record is deliberately unable to store the host address,
credentials, account identifiers, email addresses, verification or recovery
codes, prompts, responses, Profile paths, or free-form logs. It accepts only
exact source identities, candidate digests and run URLs, package hashes, fixed
statuses and timestamps, certificate expiry, and coarse operating-system
versions.

## 1. Establish reviewed SSH identity

Generate one deployment key locally:

```sh
umask 077
ssh-keygen -t ed25519 -a 100 -f OPERATOR_KEY_PATH -C aera-internal-beta
```

Obtain the server host-key fingerprint independently from the cloud console.
Capture the presented public host key, compare its fingerprint to the console,
and only then place the exact key in an owner-only `known_hosts` file. An
unreviewed `ssh-keyscan` result is not identity proof.

Copy the reviewed operator scripts and the public deployment key to the fresh
host. If the initial root login uses the provider password, enter it only at the
interactive SSH prompt. Never put it in a command, environment variable,
terminal transcript, helper utility, or file.

From the provider console or the initial interactive root session:

```sh
/opt/aera/bootstrap-host.sh prepare \
  --authorized-key-file /root/aera-deploy.pub \
  --ssh-port REVIEWED_SSH_PORT
```

The preparation step:

- creates `aera-deploy` with one Ed25519 authorized key;
- installs Docker Engine, Buildx, the Compose plugin, OpenSSL, Caddy, `age`,
  PostgreSQL client tools, Python, and a dedicated Certbot environment;
- refuses Certbot older than 5.4;
- creates `/opt/aera/internal-beta` and persistent Cloud/Admin state
  directories with narrow ownership;
- resets UFW to SSH, HTTP, and HTTPS only; and
- enables unattended security updates.

If the Docker apt repository does not support the host's Ubuntu codename, stop
instead of falling back to an unreviewed installer.

## 2. Prove key access and rotate the recovery password

From the operator workstation:

```sh
ops/internal-beta/bootstrap-host.sh verify-key-login \
  --host REVIEWED_HOST \
  --identity-file OPERATOR_KEY_PATH \
  --known-hosts-file REVIEWED_KNOWN_HOSTS_PATH \
  --ssh-port REVIEWED_SSH_PORT
```

This uses batch public-key authentication, strict host-key checking, and the
reviewed `known_hosts` file. It creates an owner-only, empty proof marker in the
deployment account.

Keep the initial root session open while cloud-console recovery is confirmed
available. In that root session, rotate the provider password interactively:

```sh
/opt/aera/bootstrap-host.sh rotate-password root
```

The script delegates directly to the system password prompt and never accepts
or records the new value. Do not harden SSH yet; complete the root-only secret
and certificate ceremonies first.

## 3. Generate independent host secrets

Run once on the host against an empty destination:

```sh
/opt/aera/generate-secrets.sh \
  --output-dir /etc/aera/internal-beta
```

The generator never overwrites an existing ceremony. It generates independent
Cloud/Admin PostgreSQL and Redis values, identity and TOTP key rings, HMACs,
OAuth/access/offline/Agent-control signing keys, Official Agent rollout and
quality pseudonym keys, MinIO credentials, an `age` backup identity, one
private Internal Admin CA with server/client certificates, and a separate
Ed25519 service-JWT key.

The complete 64-byte offline-entitlement private material occurs only in
`cloud.env`. The separate
`public/offline-entitlement-public.json` contains only its key ID and canonical
32-byte base64url public key. Review that public file before building Desktop
packages. Do not source, print, copy back, or upload either environment file.
Private trust files stay mode `0640` for the host deployment group and receive
one read-only ACL for the fixed non-root application UID used by the reviewed
Cloud/Admin images; no other host or container user is granted access.

## 4. Issue the temporary IP certificate

Before issuance, allow inbound HTTP and HTTPS in both the provider security
group and UFW. Copy the reviewed Cloud Caddy template to the host, then run:

```sh
/opt/aera/install-ip-certificate.sh issue \
  --ip REVIEWED_PUBLIC_IP \
  --caddy-template /opt/aera/internal-beta/cloud/deploy/internal-beta/Caddyfile
```

The command validates that the address is one canonical global IPv4 address,
starts a challenge-only Caddy listener, and first requests a Let's Encrypt
staging certificate. Only after the staging certificate contains the exact IP
subject alternative name does it request the trusted short-lived certificate
with webroot validation, `--ip-address`, and the `shortlived` profile.

After trusted issuance it installs the reviewed Caddy template, grants the Caddy
service read access only to that certificate lineage, installs a deploy hook
that validates and reloads Caddy, and enables a persistent four-hour renewal
timer. The ceremony registers without an email address; add an ACME account
contact later as a separate non-secret operational change.

Verify after Cloud is deployed:

```sh
/opt/aera/install-ip-certificate.sh verify \
  --ip REVIEWED_PUBLIC_IP
```

An IP certificate is intentionally short-lived. A failed renewal, invalid Caddy
configuration, unreadable key, certificate with less than one day remaining, or
failed public Cloud health probe is a release stop.

## 5. Disable password and root SSH

After secret and certificate preparation, open a second key-authenticated
`aera-deploy` session and keep it open. In the original root session:

```sh
/opt/aera/bootstrap-host.sh harden-ssh
```

The hardening command refuses to proceed without the key-login marker, validates
the SSH configuration before reload, permits only `aera-deploy`, and removes the
marker. Confirm a third key-authenticated session before closing the original
root session. Later root recovery uses the cloud console; routine Cloud/Admin
deployment uses the deployment account's Docker-group access.

## 6. Render the redacted operator record

Create a bounded input JSON matching the tested schema, then render it outside
the repositories:

```sh
node ops/internal-beta/render-operator-record.mjs \
  --input REDACTED_INPUT_JSON \
  --output /Users/zizimutou/Desktop/aera/.internal-beta-operator/operator-record.json
```

The renderer rejects unknown fields and mutable image tags, requires canonical
SHAs/digests/timestamps and GitHub Actions URLs, makes the directory `0700`,
and writes canonical JSON mode `0600`. Update this record after candidate
creation, deployment, package verification, and real-device acceptance; never
replace missing proof with a note or log excerpt.

## Stop conditions

Stop the delivery if any of these is true:

- the SSH host fingerprint was not independently matched;
- key login has not been proven before password/root SSH is disabled;
- any unexpected provider firewall, UFW, or public listener remains;
- secret generation reports an existing destination or duplicate material;
- staging or trusted certificate identity/validity verification fails;
- Caddy emits request access logs for OAuth URLs;
- Cloud/Admin candidate signature or exact-digest verification fails; or
- the Runtime checkout differs from its recorded lock.

Moving from the temporary IP to a filed domain changes the issuer. It requires a
new Desktop trust configuration and package, not just a Caddy redirect.
