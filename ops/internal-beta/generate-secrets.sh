#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'Aera internal Beta secret generation failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

random_base64() {
  openssl rand 32 | openssl base64 -A
}

random_hex() {
  openssl rand -hex "${1:-32}"
}

cloud_key_ring() {
  jq -cnS --arg key_id "$1" --arg material "$2" \
    '{($key_id): $material}'
}

admin_key_ring() {
  jq -cnS --arg key_id "$1" --arg material "$2" \
    '{active_key_id: $key_id, keys: {($key_id): $material}}'
}

record_material() {
  printf '%s' "$1" | openssl dgst -sha256 -binary | openssl base64 -A
  printf '\n'
}

generate_ed25519_raw() {
  local label=$1
  local private_pem="$work_dir/$label.pem"
  local private_der="$work_dir/$label-private.der"
  local public_der="$work_dir/$label-public.der"
  openssl genpkey -algorithm ED25519 -out "$private_pem"
  openssl pkey -in "$private_pem" -outform DER -out "$private_der"
  openssl pkey -in "$private_pem" -pubout -outform DER \
    -out "$public_der"
  [[ $(wc -c <"$private_der") -ge 32 && $(wc -c <"$public_der") -ge 32 ]] ||
    fail 'generated Ed25519 DER is too short'

  local private_material public_material
  private_material=$(
    {
      tail -c 32 "$private_der"
      tail -c 32 "$public_der"
    } | openssl base64 -A
  )
  public_material=$(tail -c 32 "$public_der" | base64url)
  [[ $(printf '%s' "$private_material" | openssl base64 -d -A | wc -c) -eq 64 ]] ||
    fail 'generated Ed25519 private material is not 64 bytes'
  python3 - "$public_material" <<'PY'
import base64
import sys

value = sys.argv[1]
try:
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
except ValueError as exc:
    raise SystemExit("generated public key is not canonical base64url") from exc
if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode().rstrip("=") != value:
    raise SystemExit("generated Ed25519 public material is not 32 bytes")
PY
  printf '%s|%s\n' "$private_material" "$public_material"
}

write_internal_admin_pki() {
  local pki_dir=$1
  local ca_key="$pki_dir/internal-admin-ca-key.pem"
  local ca_cert="$pki_dir/internal-admin-ca.pem"
  local server_key="$pki_dir/internal-admin-server-key.pem"
  local server_csr="$work_dir/internal-admin-server.csr"
  local server_cert="$pki_dir/internal-admin-server.pem"
  local client_key="$pki_dir/internal-admin-client-key.pem"
  local client_csr="$work_dir/internal-admin-client.csr"
  local client_cert="$pki_dir/internal-admin-client.pem"
  local serial_file="$work_dir/internal-admin-ca.srl"

  openssl genpkey -algorithm EC \
    -pkeyopt ec_paramgen_curve:P-256 -out "$ca_key"
  openssl req -x509 -new -sha256 -days 90 \
    -key "$ca_key" \
    -subj '/CN=Aera Internal Beta Private CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -out "$ca_cert"

  openssl genpkey -algorithm EC \
    -pkeyopt ec_paramgen_curve:P-256 -out "$server_key"
  openssl req -new -sha256 -key "$server_key" \
    -subj '/CN=aera-cloud-internal-admin' \
    -out "$server_csr"
  {
    printf 'basicConstraints=critical,CA:FALSE\n'
    printf 'keyUsage=critical,digitalSignature,keyEncipherment\n'
    printf 'extendedKeyUsage=serverAuth\n'
    printf 'subjectAltName=DNS:aera-cloud-internal-admin\n'
  } >"$work_dir/server.ext"
  openssl x509 -req -sha256 -days 30 \
    -in "$server_csr" \
    -CA "$ca_cert" -CAkey "$ca_key" -CAcreateserial \
    -CAserial "$serial_file" \
    -extfile "$work_dir/server.ext" \
    -out "$server_cert"

  openssl genpkey -algorithm EC \
    -pkeyopt ec_paramgen_curve:P-256 -out "$client_key"
  openssl req -new -sha256 -key "$client_key" \
    -subj '/CN=aera-admin-internal-beta' \
    -out "$client_csr"
  {
    printf 'basicConstraints=critical,CA:FALSE\n'
    printf 'keyUsage=critical,digitalSignature\n'
    printf 'extendedKeyUsage=clientAuth\n'
  } >"$work_dir/client.ext"
  openssl x509 -req -sha256 -days 30 \
    -in "$client_csr" \
    -CA "$ca_cert" -CAkey "$ca_key" \
    -CAserial "$serial_file" \
    -extfile "$work_dir/client.ext" \
    -out "$client_cert"

  openssl verify -purpose sslserver -CAfile "$ca_cert" "$server_cert" >/dev/null
  openssl verify -purpose sslclient -CAfile "$ca_cert" "$client_cert" >/dev/null
  chmod 0600 "$ca_key" "$server_key" "$client_key"
  chmod 0644 "$ca_cert" "$server_cert" "$client_cert"
}

write_service_jwt_keys() {
  local pki_dir=$1
  openssl genpkey -algorithm ED25519 \
    -out "$pki_dir/internal-admin-jwt-private.pem"
  openssl pkey -in "$pki_dir/internal-admin-jwt-private.pem" \
    -pubout -out "$pki_dir/internal-admin-jwt-public.pem"
  chmod 0600 "$pki_dir/internal-admin-jwt-private.pem"
  chmod 0644 "$pki_dir/internal-admin-jwt-public.pem"
}

write_admin_pki_view() {
  local pki_dir=$1
  local admin_pki_dir=$2
  install -d -m 0750 "$admin_pki_dir"
  install -m 0644 "$pki_dir/internal-admin-ca.pem" \
    "$admin_pki_dir/ca.pem"
  install -m 0644 "$pki_dir/internal-admin-client.pem" \
    "$admin_pki_dir/client.pem"
  install -m 0600 "$pki_dir/internal-admin-client-key.pem" \
    "$admin_pki_dir/client-key.pem"
  install -m 0600 "$pki_dir/internal-admin-jwt-private.pem" \
    "$admin_pki_dir/service-key.pem"
}

output_dir=/etc/aera/internal-beta
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      [[ $# -ge 2 ]] || fail '--output-dir needs a value'
      output_dir=$2
      shift 2
      ;;
    *) fail 'usage: generate-secrets.sh [--output-dir ABSOLUTE_DIRECTORY]' ;;
  esac
done

[[ $output_dir == /* && $output_dir != / && $output_dir != /etc &&
  $output_dir != /opt && $output_dir != /var ]] ||
  fail 'output directory must be a narrow absolute path'
[[ ! -L $output_dir ]] || fail 'output directory must not be a symlink'
age_keygen_command=${AERA_AGE_KEYGEN_COMMAND:-age-keygen}
[[ $age_keygen_command != *[[:space:]]* ]] ||
  fail 'age-keygen command must be one executable path'
for command_name in "$age_keygen_command" jq openssl python3; do
  require_command "$command_name"
done

if [[ -e $output_dir ]]; then
  [[ -d $output_dir ]] || fail 'output path is not a directory'
  [[ -z $(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] ||
    fail 'output directory must be empty; secret generation never overwrites'
else
  install -d -m 0750 "$output_dir"
fi
install -d -m 0750 "$output_dir/pki" "$output_dir/public"

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/aera-secret-generation.XXXXXX")
chmod 0700 "$work_dir"
cleanup() {
  find -P "$work_dir" -depth -delete
}
trap cleanup EXIT HUP INT TERM
material_ledger="$work_dir/material-hashes.txt"

cloud_postgres=$(random_hex)
cloud_redis=$(random_hex)
admin_postgres=$(random_hex)
admin_redis=$(random_hex)
minio_access=$(random_hex 16)
minio_secret=$(random_hex)

cloud_identity_encryption=$(random_base64)
cloud_identity_lookup=$(random_base64)
cloud_verification_code=$(random_base64)
cloud_verification_receipt=$(random_base64)
cloud_verification_request=$(random_base64)
cloud_browser_session=$(random_base64)
cloud_login_rate=$(random_base64)
cloud_oauth_encryption=$(random_base64)
cloud_oauth_hmac=$(random_base64)
cloud_refresh_hmac=$(random_base64)
cloud_internal_admin_hmac=$(random_base64)
cloud_rollout_hmac=$(random_base64)
cloud_quality_hmac=$(random_base64)

admin_identity_encryption=$(random_base64)
admin_identity_lookup=$(random_base64)
admin_totp_encryption=$(random_base64)
admin_session_hmac=$(random_base64)
admin_csrf_hmac=$(random_base64)
admin_operation_hmac=$(random_base64)
admin_payload=$(random_base64)

IFS='|' read -r cloud_access_private cloud_access_public < <(
  generate_ed25519_raw access-signing
)
IFS='|' read -r cloud_offline_private cloud_offline_public < <(
  generate_ed25519_raw offline-signing
)
IFS='|' read -r cloud_agent_private cloud_agent_public < <(
  generate_ed25519_raw agent-control-signing
)
[[ -n $cloud_access_public && -n $cloud_agent_public ]] ||
  fail 'generated public signing keys are empty'

for material in \
  "$cloud_postgres" "$cloud_redis" "$admin_postgres" "$admin_redis" \
  "$minio_access" "$minio_secret" \
  "$cloud_identity_encryption" "$cloud_identity_lookup" \
  "$cloud_verification_code" "$cloud_verification_receipt" \
  "$cloud_verification_request" "$cloud_browser_session" "$cloud_login_rate" \
  "$cloud_oauth_encryption" "$cloud_oauth_hmac" "$cloud_refresh_hmac" \
  "$cloud_internal_admin_hmac" "$cloud_rollout_hmac" "$cloud_quality_hmac" \
  "$admin_identity_encryption" "$admin_identity_lookup" \
  "$admin_totp_encryption" "$admin_session_hmac" "$admin_csrf_hmac" \
  "$admin_operation_hmac" "$admin_payload" "$cloud_access_private" \
  "$cloud_offline_private" "$cloud_agent_private"
do
  record_material "$material" >>"$material_ledger"
done
[[ -z $(sort "$material_ledger" | uniq -d) ]] ||
  fail 'independently generated secret material unexpectedly collided'

platform_id=$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)
offline_key_id=offline-internal-beta-v1
access_key_id=access-internal-beta-v1
agent_key_id=agent-control-internal-beta-v1

cloud_identity_encryption_ring=$(
  cloud_key_ring enc-internal-beta-v1 "$cloud_identity_encryption"
)
cloud_identity_lookup_ring=$(
  cloud_key_ring lookup-internal-beta-v1 "$cloud_identity_lookup"
)
cloud_verification_code_ring=$(
  cloud_key_ring code-internal-beta-v1 "$cloud_verification_code"
)
cloud_verification_receipt_ring=$(
  cloud_key_ring receipt-internal-beta-v1 "$cloud_verification_receipt"
)
cloud_oauth_ring=$(
  cloud_key_ring oauth-state-internal-beta-v1 "$cloud_oauth_encryption"
)
cloud_access_ring=$(
  cloud_key_ring "$access_key_id" "$cloud_access_private"
)
cloud_offline_ring=$(
  cloud_key_ring "$offline_key_id" "$cloud_offline_private"
)
cloud_agent_ring=$(
  cloud_key_ring "$agent_key_id" "$cloud_agent_private"
)
cloud_internal_admin_ring=$(
  cloud_key_ring internal-admin-internal-beta-v1 "$cloud_internal_admin_hmac"
)
cloud_rollout_ring=$(
  cloud_key_ring rollout-internal-beta-v1 "$cloud_rollout_hmac"
)
cloud_quality_ring=$(
  cloud_key_ring quality-internal-beta-v1 "$cloud_quality_hmac"
)

admin_identity_encryption_ring=$(
  admin_key_ring enc-internal-beta-v1 "$admin_identity_encryption"
)
admin_identity_lookup_ring=$(
  admin_key_ring lookup-internal-beta-v1 "$admin_identity_lookup"
)
admin_totp_ring=$(
  admin_key_ring totp-internal-beta-v1 "$admin_totp_encryption"
)

write_internal_admin_pki "$output_dir/pki"
write_service_jwt_keys "$output_dir/pki"
write_admin_pki_view "$output_dir/pki" "$output_dir/admin-pki"
"$age_keygen_command" -o "$output_dir/backup-age-identity.txt" >/dev/null 2>&1
backup_recipient=$(
  "$age_keygen_command" -y "$output_dir/backup-age-identity.txt"
)
[[ $backup_recipient == age1* ]] || fail 'backup age recipient is invalid'
chmod 0600 "$output_dir/backup-age-identity.txt"

cloud_env="$output_dir/cloud.env"
{
  printf 'AERA_CLOUD_POSTGRES_PASSWORD=%s\n' "$cloud_postgres"
  printf 'AERA_CLOUD_REDIS_PASSWORD=%s\n' "$cloud_redis"
  printf 'AGENTERA_CLOUD_ENCRYPTED_BACKUP_ACCESS_KEY=%s\n' "$minio_access"
  printf 'AGENTERA_CLOUD_ENCRYPTED_BACKUP_SECRET_KEY=%s\n' "$minio_secret"
  printf 'AERA_CLOUD_INTERNAL_ADMIN_SERVER_CERT_FILE_HOST=%s\n' \
    "$output_dir/pki/internal-admin-server.pem"
  printf 'AERA_CLOUD_INTERNAL_ADMIN_SERVER_KEY_FILE_HOST=%s\n' \
    "$output_dir/pki/internal-admin-server-key.pem"
  printf 'AERA_CLOUD_INTERNAL_ADMIN_CLIENT_CA_FILE_HOST=%s\n' \
    "$output_dir/pki/internal-admin-ca.pem"
  printf 'AERA_CLOUD_INTERNAL_ADMIN_JWT_PUBLIC_KEY_FILE_HOST=%s\n' \
    "$output_dir/pki/internal-admin-jwt-public.pem"
  printf 'AGENTERA_CLOUD_IDENTITY_ENCRYPTION_ACTIVE_KEY_ID=enc-internal-beta-v1\n'
  printf 'AGENTERA_CLOUD_IDENTITY_ENCRYPTION_KEYS=%s\n' \
    "$cloud_identity_encryption_ring"
  printf 'AGENTERA_CLOUD_IDENTITY_LOOKUP_ACTIVE_KEY_ID=lookup-internal-beta-v1\n'
  printf 'AGENTERA_CLOUD_IDENTITY_LOOKUP_KEYS=%s\n' "$cloud_identity_lookup_ring"
  printf 'AGENTERA_CLOUD_VERIFICATION_CODE_ACTIVE_KEY_ID=code-internal-beta-v1\n'
  printf 'AGENTERA_CLOUD_VERIFICATION_CODE_KEYS=%s\n' "$cloud_verification_code_ring"
  printf 'AGENTERA_CLOUD_VERIFICATION_RECEIPT_ACTIVE_KEY_ID=receipt-internal-beta-v1\n'
  printf 'AGENTERA_CLOUD_VERIFICATION_RECEIPT_KEYS=%s\n' \
    "$cloud_verification_receipt_ring"
  printf 'AGENTERA_CLOUD_VERIFICATION_REQUEST_HMAC_KEY=%s\n' \
    "$cloud_verification_request"
  printf 'AGENTERA_CLOUD_BROWSER_SESSION_HMAC_KEY=%s\n' "$cloud_browser_session"
  printf 'AGENTERA_CLOUD_LOGIN_RATE_HMAC_KEY=%s\n' "$cloud_login_rate"
  printf 'AGENTERA_CLOUD_OAUTH_STATE_ENCRYPTION_ACTIVE_KEY_ID=oauth-state-internal-beta-v1\n'
  printf 'AGENTERA_CLOUD_OAUTH_STATE_ENCRYPTION_KEYS=%s\n' "$cloud_oauth_ring"
  printf 'AGENTERA_CLOUD_OAUTH_STATE_HMAC_KEY=%s\n' "$cloud_oauth_hmac"
  printf 'AGENTERA_CLOUD_REFRESH_TOKEN_HMAC_KEY=%s\n' "$cloud_refresh_hmac"
  printf 'AGENTERA_CLOUD_ACCESS_SIGNING_ACTIVE_KEY_ID=%s\n' "$access_key_id"
  printf 'AGENTERA_CLOUD_ACCESS_SIGNING_KEYS=%s\n' "$cloud_access_ring"
  printf 'AGENTERA_CLOUD_OFFLINE_SIGNING_ACTIVE_KEY_ID=%s\n' "$offline_key_id"
  printf 'AGENTERA_CLOUD_OFFLINE_SIGNING_KEYS=%s\n' "$cloud_offline_ring"
  printf 'AGENTERA_CLOUD_AGENT_CONTROL_SIGNING_ACTIVE_KEY_ID=%s\n' "$agent_key_id"
  printf 'AGENTERA_CLOUD_AGENT_CONTROL_SIGNING_KEYS=%s\n' "$cloud_agent_ring"
  printf 'AGENTERA_CLOUD_OFFLINE_POLICY_VERSION=1\n'
  printf 'AGENTERA_CLOUD_ACTIVE_DEVICE_LIMIT=5\n'
  printf 'AGENTERA_CLOUD_BROWSER_COOKIE_NAME=aera_internal_beta_session\n'
  printf 'AGENTERA_CLOUD_BROWSER_SESSION_TTL_SECONDS=900\n'
  printf 'AGENTERA_CLOUD_LOGIN_IDENTITY_LIMIT=5\n'
  printf 'AGENTERA_CLOUD_LOGIN_IP_LIMIT=20\n'
  printf 'AGENTERA_CLOUD_LOGIN_WINDOW_SECONDS=600\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_ACTIVE_OWNED_LIMIT=10\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_MEMBER_LIMIT=100\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_PENDING_INVITE_LIMIT=20\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_CREATE_RATE_LIMIT=10\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_CREATE_RATE_WINDOW=1h\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_INVITE_RATE_LIMIT=20\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_INVITE_RATE_WINDOW=1h\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_ACCEPT_RATE_LIMIT=30\n'
  printf 'AGENTERA_CLOUD_WORKSPACE_ACCEPT_RATE_WINDOW=10m\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_OWNED_LIMIT=3\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_MEMBER_LIMIT=500\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_DEPARTMENT_LIMIT=50\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_PENDING_INVITE_LIMIT=100\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_CREATE_RATE_LIMIT=6\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_CREATE_RATE_WINDOW=1h\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_INVITE_RATE_LIMIT=30\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_INVITE_RATE_WINDOW=1h\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_ACCEPT_RATE_LIMIT=30\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_ACCEPT_RATE_WINDOW=10m\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_MUTATION_RATE_LIMIT=120\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_MUTATION_RATE_WINDOW=1h\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_HIGH_RISK_RATE_LIMIT=20\n'
  printf 'AGENTERA_CLOUD_ORGANIZATION_HIGH_RISK_RATE_WINDOW=1h\n'
  printf 'AGENTERA_CLOUD_TERMS_VERSION=terms-2026-07\n'
  printf 'AGENTERA_CLOUD_PRIVACY_VERSION=privacy-2026-07\n'
  printf 'AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_ISSUER=aera-admin\n'
  printf 'AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_SUBJECT=aera-admin-internal-beta\n'
  printf 'AGENTERA_CLOUD_INTERNAL_ADMIN_HMAC_ACTIVE_KEY_ID=internal-admin-internal-beta-v1\n'
  printf 'AGENTERA_CLOUD_INTERNAL_ADMIN_HMAC_KEYS=%s\n' \
    "$cloud_internal_admin_ring"
  printf 'AGENTERA_CLOUD_PLATFORM_ID=%s\n' "$platform_id"
  printf 'AGENTERA_CLOUD_PLATFORM_KEY=aera_official\n'
  printf 'AGENTERA_CLOUD_PLATFORM_DISPLAY_NAME=Aera Official\n'
  printf 'AGENTERA_CLOUD_OFFICIAL_ROLLOUT_HMAC_ACTIVE_KEY_ID=rollout-internal-beta-v1\n'
  printf 'AGENTERA_CLOUD_OFFICIAL_ROLLOUT_HMAC_KEYS=%s\n' "$cloud_rollout_ring"
  printf 'AGENTERA_CLOUD_OFFICIAL_QUALITY_PSEUDONYM_HMAC_ACTIVE_KEY_ID=quality-internal-beta-v1\n'
  printf 'AGENTERA_CLOUD_OFFICIAL_QUALITY_PSEUDONYM_HMAC_KEYS=%s\n' \
    "$cloud_quality_ring"
  printf 'AGENTERA_BACKUP_AGE_RECIPIENT=%s\n' "$backup_recipient"
} >"$cloud_env"
chmod 0600 "$cloud_env"

admin_cloud_scopes='["users:read","devices:write","sessions:write","accounts:write","operations:read","official_agents:read","official_agent_drafts:write","official_agent_reviews:write","official_agent_releases:write","official_agent_audit:read","official_quality:read","official_quality:propose","official_quality:review","official_quality:clone"]'
admin_env="$output_dir/admin.env"
{
  printf 'AERA_ADMIN_POSTGRES_PASSWORD=%s\n' "$admin_postgres"
  printf 'AERA_ADMIN_REDIS_PASSWORD=%s\n' "$admin_redis"
  printf 'AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS=%s\n' \
    "$admin_identity_encryption_ring"
  printf 'AERA_ADMIN_IDENTITY_LOOKUP_KEYS=%s\n' "$admin_identity_lookup_ring"
  printf 'AERA_ADMIN_TOTP_ENCRYPTION_KEYS=%s\n' "$admin_totp_ring"
  printf 'AERA_ADMIN_SESSION_HMAC_KEY=%s\n' "$admin_session_hmac"
  printf 'AERA_ADMIN_CSRF_HMAC_KEY=%s\n' "$admin_csrf_hmac"
  printf 'AERA_ADMIN_OPERATION_HMAC_KEY=%s\n' "$admin_operation_hmac"
  printf 'PAYLOAD_SECRET=%s\n' "$admin_payload"
  printf 'AERA_ADMIN_CLOUD_CA_FILE_HOST=%s\n' \
    "$output_dir/pki/internal-admin-ca.pem"
  printf 'AERA_ADMIN_CLOUD_CLIENT_CERT_FILE_HOST=%s\n' \
    "$output_dir/pki/internal-admin-client.pem"
  printf 'AERA_ADMIN_CLOUD_CLIENT_KEY_FILE_HOST=%s\n' \
    "$output_dir/pki/internal-admin-client-key.pem"
  printf 'AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE_HOST=%s\n' \
    "$output_dir/pki/internal-admin-jwt-private.pem"
  printf 'AERA_ADMIN_CLOUD_JWT_ISSUER=aera-admin\n'
  printf 'AERA_ADMIN_CLOUD_JWT_SUBJECT=aera-admin-internal-beta\n'
  printf 'AERA_ADMIN_CLOUD_SCOPES=%s\n' "$admin_cloud_scopes"
  printf 'AGENTERA_CLOUD_ADMIN_BASE_URL=https://aera-cloud-internal-admin:8443\n'
  printf 'AGENTERA_CLOUD_ADMIN_JWT_ISSUER=aera-admin\n'
  printf 'AGENTERA_CLOUD_ADMIN_JWT_SUBJECT=aera-admin-internal-beta\n'
  printf 'AGENTERA_CLOUD_ADMIN_SCOPES=%s\n' "$admin_cloud_scopes"
  printf 'AERA_BACKUP_AGE_RECIPIENT=%s\n' "$backup_recipient"
} >"$admin_env"
chmod 0600 "$admin_env"

jq -cnS \
  --arg keyId "$offline_key_id" \
  --arg publicKey "$cloud_offline_public" \
  '{keyId: $keyId, publicKey: $publicKey, schemaVersion: 1}' \
  >"$output_dir/public/offline-entitlement-public.json"
chmod 0644 "$output_dir/public/offline-entitlement-public.json"

if [[ $(id -u) -eq 0 ]] && getent group aera-deploy >/dev/null; then
  require_command setfacl
  chown -R root:aera-deploy "$output_dir"
  chmod 0750 \
    "$output_dir" \
    "$output_dir/pki" \
    "$output_dir/public" \
    "$output_dir/admin-pki"
  find "$output_dir" -type f -name '*-key.pem' -exec chmod 0640 {} +
  chmod 0640 \
    "$output_dir/cloud.env" \
    "$output_dir/admin.env" \
    "$output_dir/backup-age-identity.txt" \
    "$output_dir/admin-pki/client-key.pem" \
    "$output_dir/admin-pki/service-key.pem" \
    "$output_dir/pki/internal-admin-ca-key.pem" \
    "$output_dir/pki/internal-admin-jwt-private.pem"
  setfacl -m u:1001:--x "$output_dir/admin-pki"
  setfacl -m u:1001:r-- \
    "$output_dir/admin-pki/ca.pem" \
    "$output_dir/admin-pki/client.pem" \
    "$output_dir/admin-pki/client-key.pem" \
    "$output_dir/admin-pki/service-key.pem"
  setfacl -m u:65532:r-- \
    "$output_dir/pki/internal-admin-ca.pem" \
    "$output_dir/pki/internal-admin-server.pem" \
    "$output_dir/pki/internal-admin-server-key.pem" \
    "$output_dir/pki/internal-admin-client.pem" \
    "$output_dir/pki/internal-admin-client-key.pem" \
    "$output_dir/pki/internal-admin-jwt-private.pem" \
    "$output_dir/pki/internal-admin-jwt-public.pem"
fi

printf 'Aera internal Beta secret material generated without printing secret values.\n'
printf 'Review the separate public offline-entitlement file before Desktop packaging.\n'
