#!/usr/bin/env bash
set -euo pipefail
umask 077

certbot=/opt/aera/certbot-venv/bin/certbot
webroot=/var/lib/aera-certbot
caddy_config=/etc/caddy/Caddyfile
caddy_environment=/etc/aera/internal-beta/caddy.env
caddy_override=/etc/systemd/system/caddy.service.d/aera-internal-beta.conf
renew_hook=/etc/letsencrypt/renewal-hooks/deploy/aera-reload-caddy
certificate_probe=

fail() {
  printf 'Aera IP certificate ceremony failed: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [[ $(id -u) -eq 0 ]] || fail 'certificate operations must run as root'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

validate_ip() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError as exc:
    raise SystemExit("address is invalid") from exc
if address.version != 4 or not address.is_global:
    raise SystemExit("address must be one public IPv4 address")
if str(address) != sys.argv[1]:
    raise SystemExit("address must be canonical")
PY
}

certificate_name_for() {
  printf 'aera-ip-%s\n' "${1//./-}"
}

validate_certbot_version() {
  [[ -x $certbot ]] || fail 'the dedicated Certbot installation is missing'
  local version
  version=$("$certbot" --version | awk '{print $2}')
  python3 - "$version" <<'PY'
import sys

try:
    version = tuple(int(part) for part in sys.argv[1].split(".")[:2])
except ValueError as exc:
    raise SystemExit("Certbot version is invalid") from exc
if version < (5, 4):
    raise SystemExit("Certbot 5.4 or newer is required for IP certificates")
PY
}

write_caddy_environment() {
  local ip=$1
  local certificate_name=$2
  install -d -m 0750 /etc/aera/internal-beta
  {
    printf 'AERA_INTERNAL_BETA_IP=%s\n' "$ip"
    printf 'AERA_INTERNAL_BETA_CERTIFICATE_NAME=%s\n' "$certificate_name"
  } >"$caddy_environment"
  chmod 0600 "$caddy_environment"

  install -d -m 0755 "$(dirname "$caddy_override")"
  {
    printf '[Service]\n'
    printf 'EnvironmentFile=%s\n' "$caddy_environment"
  } >"$caddy_override"
  chmod 0644 "$caddy_override"
  systemctl daemon-reload
}

write_challenge_caddyfile() {
  # shellcheck disable=SC2016
  {
    printf '{\n'
    printf '\tauto_https off\n'
    printf '\tadmin off\n'
    printf '}\n\n'
    printf 'http://{$AERA_INTERNAL_BETA_IP} {\n'
    printf '\thandle /.well-known/acme-challenge/* {\n'
    printf '\t\troot * %s\n' "$webroot"
    printf '\t\tfile_server\n'
    printf '\t}\n'
    printf '\trespond "Aera internal Beta HTTPS is not ready" 503\n'
    printf '}\n'
  } >"$caddy_config"
  chmod 0644 "$caddy_config"
}

with_caddy_environment() {
  set -a
  # shellcheck source=/dev/null
  . "$caddy_environment"
  set +a
  "$@"
}

prepare_challenge_server() {
  local ip=$1
  local certificate_name=$2
  install -d -m 0755 "$webroot/.well-known/acme-challenge"
  write_caddy_environment "$ip" "$certificate_name"
  write_challenge_caddyfile
  with_caddy_environment caddy validate --config "$caddy_config" >/dev/null
  systemctl enable --now caddy
  systemctl reload caddy

  local probe
  probe=$(openssl rand -hex 12)
  printf '%s\n' "$probe" >"$webroot/.well-known/acme-challenge/aera-probe"
  chmod 0644 "$webroot/.well-known/acme-challenge/aera-probe"
  local observed
  observed=$(curl --fail --silent --show-error \
    --connect-to "$ip:80:localhost:80" \
    "http://$ip/.well-known/acme-challenge/aera-probe")
  [[ $observed == "$probe" ]] || fail 'local ACME webroot probe failed'
  unlink "$webroot/.well-known/acme-challenge/aera-probe"
}

verify_certificate_identity() {
  local lineage=$1
  local ip=$2
  [[ -r $lineage/fullchain.pem && -r $lineage/privkey.pem ]] ||
    fail 'issued certificate lineage is incomplete'
  openssl x509 -in "$lineage/fullchain.pem" -noout \
    -ext subjectAltName | grep -Fq "IP Address:$ip" ||
    fail 'issued certificate does not contain the exact IP subjectAltName'
  openssl x509 -in "$lineage/fullchain.pem" -checkend 86400 -noout ||
    fail 'issued certificate has less than one day of validity'
}

write_reload_hook() {
  install -d -m 0755 "$(dirname "$renew_hook")"
  # shellcheck disable=SC2016
  {
    printf '#!/bin/sh\n'
    printf 'set -eu\n'
    printf 'lineage=${RENEWED_LINEAGE:?}\n'
    printf 'case "$lineage" in\n'
    printf '  /etc/letsencrypt/live/aera-ip-*) ;;\n'
    printf '  *) exit 1 ;;\n'
    printf 'esac\n'
    printf 'archive=/etc/letsencrypt/archive/${lineage##*/}\n'
    printf 'test -d "$archive"\n'
    printf 'setfacl -m u:caddy:--x /etc/letsencrypt /etc/letsencrypt/live /etc/letsencrypt/archive\n'
    printf 'setfacl -R -m u:caddy:rX "$lineage" "$archive"\n'
    printf 'set -a\n'
    printf '. /etc/aera/internal-beta/caddy.env\n'
    printf 'set +a\n'
    printf 'caddy validate --config /etc/caddy/Caddyfile >/dev/null\n'
    printf 'systemctl reload caddy\n'
  } >"$renew_hook"
  chmod 0755 "$renew_hook"
}

grant_caddy_certificate_access() {
  local lineage=$1
  RENEWED_LINEAGE="$lineage" "$renew_hook"
}

install_renew_timer() {
  {
    printf '[Unit]\n'
    printf 'Description=Renew Aera short-lived IP certificate\n\n'
    printf '[Service]\n'
    printf 'Type=oneshot\n'
    printf 'ExecStart=%s renew --quiet\n' "$certbot"
    printf 'PrivateTmp=true\n'
  } >/etc/systemd/system/aera-certbot-renew.service
  {
    printf '[Unit]\n'
    printf 'Description=Check Aera short-lived IP certificate renewal\n\n'
    printf '[Timer]\n'
    printf 'OnCalendar=*-*-* 00/4:17:00\n'
    printf 'RandomizedDelaySec=20m\n'
    printf 'Persistent=true\n\n'
    printf '[Install]\n'
    printf 'WantedBy=timers.target\n'
  } >/etc/systemd/system/aera-certbot-renew.timer
  chmod 0644 \
    /etc/systemd/system/aera-certbot-renew.service \
    /etc/systemd/system/aera-certbot-renew.timer
  systemctl daemon-reload
  systemctl enable --now aera-certbot-renew.timer
}

issue_certificate() {
  require_root
  local ip='' caddy_template=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ip)
        [[ $# -ge 2 ]] || fail '--ip needs a value'
        ip=$2
        shift 2
        ;;
      --caddy-template)
        [[ $# -ge 2 ]] || fail '--caddy-template needs a value'
        caddy_template=$2
        shift 2
        ;;
      *) fail 'unknown issue argument' ;;
    esac
  done
  [[ -n $ip ]] || fail '--ip is required'
  validate_ip "$ip"
  [[ -f $caddy_template && ! -L $caddy_template ]] ||
    fail 'reviewed Caddy template is required'
  for command_name in caddy curl grep openssl python3 setfacl systemctl; do
    require_command "$command_name"
  done
  validate_certbot_version

  local certificate_name staging_name production_lineage
  certificate_name=$(certificate_name_for "$ip")
  staging_name="${certificate_name}-staging"
  production_lineage="/etc/letsencrypt/live/$certificate_name"
  prepare_challenge_server "$ip" "$certificate_name"

  "$certbot" certonly \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --staging \
    --preferred-profile shortlived \
    --webroot \
    --webroot-path "$webroot" \
    --ip-address "$ip" \
    --cert-name "$staging_name"
  verify_certificate_identity "/etc/letsencrypt/live/$staging_name" "$ip"

  "$certbot" certonly \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --preferred-profile shortlived \
    --webroot \
    --webroot-path "$webroot" \
    --ip-address "$ip" \
    --cert-name "$certificate_name"
  verify_certificate_identity "$production_lineage" "$ip"

  install -m 0644 "$caddy_template" "$caddy_config"
  write_reload_hook
  grant_caddy_certificate_access "$production_lineage"
  with_caddy_environment caddy validate --config "$caddy_config" >/dev/null
  systemctl reload caddy
  install_renew_timer

  "$certbot" delete --non-interactive --cert-name "$staging_name" >/dev/null
  printf 'Aera trusted short-lived IP certificate installed and renewal enabled.\n'
}

verify_live_certificate() {
  local ip=
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ip)
        [[ $# -ge 2 ]] || fail '--ip needs a value'
        ip=$2
        shift 2
        ;;
      *) fail 'unknown verify argument' ;;
    esac
  done
  [[ -n $ip ]] || fail '--ip is required'
  validate_ip "$ip"
  certificate_probe=$(mktemp "${TMPDIR:-/tmp}/aera-live-certificate.XXXXXX")
  chmod 0600 "$certificate_probe"
  trap '[[ -z ${certificate_probe:-} || ! -f $certificate_probe ]] || unlink "$certificate_probe"' EXIT
  openssl s_client \
    -connect "$ip:443" \
    -verify_ip "$ip" \
    -verify_return_error \
    -showcerts </dev/null 2>/dev/null |
    openssl x509 -out "$certificate_probe"
  openssl x509 -in "$certificate_probe" -noout \
    -ext subjectAltName | grep -Fq "IP Address:$ip" ||
    fail 'live certificate does not contain the exact IP subjectAltName'
  openssl x509 -in "$certificate_probe" -checkend 86400 -noout ||
    fail 'live certificate has less than one day of validity'
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --max-time 20 "https://$ip/health/live" >/dev/null
  systemctl is-active --quiet caddy
  systemctl is-enabled --quiet aera-certbot-renew.timer
  unlink "$certificate_probe"
  printf 'Aera live IP certificate and renewal verification passed.\n'
}

case "${1:-}" in
  issue)
    shift
    issue_certificate "$@"
    ;;
  verify)
    shift
    verify_live_certificate "$@"
    ;;
  *)
    fail 'usage: install-ip-certificate.sh issue|verify'
    ;;
esac
