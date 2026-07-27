#!/usr/bin/env bash
set -euo pipefail
umask 077

deploy_user=aera-deploy
install_root=/opt/aera/internal-beta
secret_root=/etc/aera/internal-beta
state_root=/var/lib/aera/internal-beta
certbot_venv=/opt/aera/certbot-venv
cosign_version=3.0.6
cosign_install=/usr/local/bin/cosign
caddy_config=/etc/caddy/Caddyfile
verification_marker=.aera-key-login-verified

fail() {
  printf 'Aera host bootstrap failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_root() {
  [[ $(id -u) -eq 0 ]] || fail 'this operation must run as root'
}

validate_port() {
  [[ $1 =~ ^[1-9][0-9]{0,4}$ && $1 -le 65535 ]] ||
    fail 'SSH port must be an integer from 1 through 65535'
}

install_docker_repository() {
  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error --location --ipv4 \
    --retry 5 --retry-all-errors --retry-delay 1 \
    --connect-timeout 10 --max-time 60 \
    https://download.docker.com/linux/ubuntu/gpg \
    --output /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc

  # shellcheck source=/dev/null
  . /etc/os-release
  local codename architecture
  codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
  architecture=$(dpkg --print-architecture)
  [[ -n $codename && -n $architecture ]] ||
    fail 'Ubuntu codename or architecture is unavailable'
  {
    printf 'Types: deb\n'
    printf 'URIs: https://download.docker.com/linux/ubuntu\n'
    printf 'Suites: %s\n' "$codename"
    printf 'Components: stable\n'
    printf 'Architectures: %s\n' "$architecture"
    printf 'Signed-By: /etc/apt/keyrings/docker.asc\n'
  } >/etc/apt/sources.list.d/docker.sources
  chmod 0644 /etc/apt/sources.list.d/docker.sources
}

install_cosign() {
  local architecture digest download temporary actual_version
  architecture=$(dpkg --print-architecture)
  case "$architecture" in
    amd64)
      digest=c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74
      ;;
    arm64)
      digest=bedac92e8c3729864e13d4a17048007cfafa79d5deca993a43a90ffe018ef2b8
      ;;
    *) fail "Cosign does not support host architecture $architecture" ;;
  esac
  if [[ -x $cosign_install ]] &&
    printf '%s  %s\n' "$digest" "$cosign_install" |
      sha256sum --check --status &&
    [[ $(
      "$cosign_install" version |
        awk '$1 == "GitVersion:" {print $2; exit}'
    ) == "v$cosign_version" ]]; then
    return
  fi

  download="https://github.com/sigstore/cosign/releases/download/v${cosign_version}/cosign-linux-${architecture}"
  temporary=$(mktemp "${TMPDIR:-/tmp}/aera-cosign.XXXXXX")

  if ! curl --fail --silent --show-error --location --ipv4 \
    --retry 5 --retry-all-errors --retry-delay 1 \
    --connect-timeout 10 --max-time 300 \
    "$download" --output "$temporary"; then
    unlink "$temporary"
    fail 'Cosign download failed'
  fi
  if ! printf '%s  %s\n' "$digest" "$temporary" |
    sha256sum --check --status; then
    unlink "$temporary"
    fail 'Cosign checksum verification failed'
  fi
  install -m 0755 -o root -g root "$temporary" "$cosign_install"
  unlink "$temporary"

  actual_version=$(
    "$cosign_install" version |
      awk '$1 == "GitVersion:" {print $2; exit}'
  )
  [[ $actual_version == "v$cosign_version" ]] ||
    fail 'installed Cosign version does not match candidate CI'
}

install_certbot() {
  python3 -m venv "$certbot_venv"
  "$certbot_venv/bin/python" -m pip install --disable-pip-version-check \
    --upgrade pip
  "$certbot_venv/bin/python" -m pip install --disable-pip-version-check \
    'certbot>=5.4,<6'
  local version
  version=$("$certbot_venv/bin/certbot" --version | awk '{print $2}')
  "$certbot_venv/bin/python" - "$version" <<'PY'
import sys

parts = sys.argv[1].split(".")
try:
    version = tuple(int(part) for part in parts[:2])
except ValueError as exc:
    raise SystemExit("Certbot version is invalid") from exc
if version < (5, 4):
    raise SystemExit("Certbot 5.4 or newer is required")
PY
}

ensure_caddy_bootstrap_config() {
  if [[ -e $caddy_config || -L $caddy_config ]]; then
    [[ -f $caddy_config && ! -L $caddy_config ]] ||
      fail 'existing Caddy configuration must be one regular file'
    return
  fi

  install -d -m 0755 "$(dirname "$caddy_config")"
  {
    printf '{\n'
    printf '\tauto_https off\n'
    printf '\tadmin off\n'
    printf '}\n\n'
    printf 'http://localhost {\n'
    printf '\trespond "Aera host preparation is waiting for certificate configuration" 503\n'
    printf '}\n'
  } >"$caddy_config"
  chmod 0644 "$caddy_config"
  caddy validate --config "$caddy_config" >/dev/null
}

configure_deploy_user() {
  local authorized_key_file=$1
  if ! getent passwd "$deploy_user" >/dev/null; then
    useradd --create-home --shell /bin/bash "$deploy_user"
  fi
  usermod --append --groups docker "$deploy_user"

  local deploy_home
  deploy_home=$(getent passwd "$deploy_user" | cut -d: -f6)
  [[ -n $deploy_home && $deploy_home == /home/* ]] ||
    fail 'deploy account home is invalid'
  install -d -m 0700 -o "$deploy_user" -g "$deploy_user" \
    "$deploy_home/.ssh"
  install -m 0600 -o "$deploy_user" -g "$deploy_user" \
    "$authorized_key_file" "$deploy_home/.ssh/authorized_keys"
}

configure_directories() {
  install -d -m 0755 -o root -g root /opt/aera
  install -d -m 0755 -o root -g root /etc/aera
  install -d -m 0755 -o root -g root /var/lib/aera
  install -d -m 0700 -o "$deploy_user" -g "$deploy_user" "$install_root"
  install -d -m 0700 -o "$deploy_user" -g "$deploy_user" \
    "$install_root/cloud" "$install_root/admin" "$install_root/desktop"
  install -d -m 0750 -o root -g "$deploy_user" "$secret_root"
  install -d -m 0700 -o "$deploy_user" -g "$deploy_user" \
    "$state_root" "$state_root/cloud" "$state_root/admin"
  install -d -m 0755 -o root -g root /var/lib/aera-certbot
}

configure_unattended_updates() {
  {
    printf 'APT::Periodic::Update-Package-Lists "1";\n'
    printf 'APT::Periodic::Unattended-Upgrade "1";\n'
  } >/etc/apt/apt.conf.d/20auto-upgrades
  chmod 0644 /etc/apt/apt.conf.d/20auto-upgrades
  systemctl enable --now unattended-upgrades
}

reload_ssh_service() {
  if systemctl cat ssh.service >/dev/null 2>&1; then
    systemctl reload ssh
  else
    systemctl reload sshd
  fi
}

configure_ssh_port() {
  local ssh_port=$1 configured_port matched=false
  install -d -m 0755 /etc/ssh/sshd_config.d
  printf 'Port %s\n' "$ssh_port" \
    >/etc/ssh/sshd_config.d/98-aera-internal-beta-port.conf
  chmod 0644 /etc/ssh/sshd_config.d/98-aera-internal-beta-port.conf
  /usr/sbin/sshd -t
  while read -r configured_port; do
    if [[ $configured_port == "$ssh_port" ]]; then
      matched=true
      break
    fi
  done < <(/usr/sbin/sshd -T | awk '$1 == "port" {print $2}')
  [[ $matched == true ]] ||
    fail 'requested SSH port is absent from the effective sshd configuration'
}

configure_firewall() {
  local ssh_port=$1
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "${ssh_port}/tcp" comment 'Aera SSH' >/dev/null
  ufw allow 80/tcp comment 'Aera ACME HTTP' >/dev/null
  ufw allow 443/tcp comment 'Aera HTTPS' >/dev/null
  ufw --force enable >/dev/null

  local rule_count
  rule_count=$(ufw status numbered | awk '/^\[[[:space:]]*[0-9]+\]/{count++} END{print count+0}')
  [[ $rule_count -eq 3 || $rule_count -eq 6 ]] ||
    fail 'UFW must expose only SSH, HTTP, and HTTPS for both address families'
}

prepare_host() {
  require_root
  local authorized_key_file='' ssh_port=22
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --authorized-key-file)
        [[ $# -ge 2 ]] || fail '--authorized-key-file needs a value'
        authorized_key_file=$2
        shift 2
        ;;
      --ssh-port)
        [[ $# -ge 2 ]] || fail '--ssh-port needs a value'
        ssh_port=$2
        shift 2
        ;;
      *) fail 'unknown prepare argument' ;;
    esac
  done
  validate_port "$ssh_port"
  [[ -f $authorized_key_file && ! -L $authorized_key_file ]] ||
    fail 'authorized Ed25519 public-key file is required'
  [[ $(wc -l <"$authorized_key_file") -eq 1 ]] ||
    fail 'authorized-key file must contain exactly one line'
  grep -Eq '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^[:cntrl:]]+)?$' \
    "$authorized_key_file" ||
    fail 'authorized key must be one Ed25519 public key'
  require_command apt-get
  require_command curl

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y \
    acl \
    age \
    ca-certificates \
    caddy \
    curl \
    gnupg \
    jq \
    openssl \
    postgresql-client \
    python3 \
    python3-cryptography \
    python3-venv \
    ufw \
    unattended-upgrades

  install_docker_repository
  apt-get update
  apt-get install -y \
    containerd.io \
    docker-buildx-plugin \
    docker-ce \
    docker-ce-cli \
    docker-compose-plugin

  systemctl enable --now docker
  ensure_caddy_bootstrap_config
  systemctl enable --now caddy
  docker version >/dev/null
  docker compose version >/dev/null
  install_cosign
  install_certbot
  configure_deploy_user "$authorized_key_file"
  configure_directories
  configure_unattended_updates
  configure_ssh_port "$ssh_port"
  configure_firewall "$ssh_port"
  reload_ssh_service

  printf 'Aera host preparation completed; verify key login before SSH hardening.\n'
}

verify_key_login() {
  local host='' identity_file='' known_hosts_file='' ssh_port=22
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host)
        [[ $# -ge 2 ]] || fail '--host needs a value'
        host=$2
        shift 2
        ;;
      --identity-file)
        [[ $# -ge 2 ]] || fail '--identity-file needs a value'
        identity_file=$2
        shift 2
        ;;
      --known-hosts-file)
        [[ $# -ge 2 ]] || fail '--known-hosts-file needs a value'
        known_hosts_file=$2
        shift 2
        ;;
      --ssh-port)
        [[ $# -ge 2 ]] || fail '--ssh-port needs a value'
        ssh_port=$2
        shift 2
        ;;
      *) fail 'unknown verify-key-login argument' ;;
    esac
  done
  validate_port "$ssh_port"
  [[ -n $host && $host != -* && $host != *[[:space:]]* ]] ||
    fail 'host is required'
  [[ -f $identity_file && ! -L $identity_file ]] ||
    fail 'identity file is required'
  [[ -f $known_hosts_file && ! -L $known_hosts_file ]] ||
    fail 'reviewed known-hosts file is required'
  require_command ssh

  ssh \
    -p "$ssh_port" \
    -i "$identity_file" \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$known_hosts_file" \
    "$deploy_user@$host" \
    "umask 077; : > \"\$HOME/$verification_marker\"; chmod 600 \"\$HOME/$verification_marker\""
  printf 'Aera deploy key login verified.\n'
}

rotate_account_password() {
  require_root
  [[ $# -eq 1 ]] || fail 'rotate-password requires root or aera-deploy'
  case "$1" in
    root | "$deploy_user") ;;
    *) fail 'password rotation target is not allowed' ;;
  esac
  passwd "$1"
}

harden_ssh() {
  require_root
  [[ $# -eq 0 ]] || fail 'harden-ssh takes no arguments'
  local deploy_home marker marker_owner marker_mode
  deploy_home=$(getent passwd "$deploy_user" | cut -d: -f6)
  marker="$deploy_home/$verification_marker"
  [[ -f $marker && ! -L $marker && ! -s $marker ]] ||
    fail 'successful key-login proof is missing'
  marker_owner=$(stat -c '%U' "$marker")
  marker_mode=$(stat -c '%a' "$marker")
  [[ $marker_owner == "$deploy_user" && $marker_mode == 600 ]] ||
    fail 'key-login proof owner or mode is invalid'

  install -d -m 0755 /etc/ssh/sshd_config.d
  {
    printf 'PubkeyAuthentication yes\n'
    printf 'PasswordAuthentication no\n'
    printf 'KbdInteractiveAuthentication no\n'
    printf 'PermitRootLogin no\n'
    printf 'AllowUsers %s\n' "$deploy_user"
  } >/etc/ssh/sshd_config.d/99-aera-internal-beta.conf
  chmod 0644 /etc/ssh/sshd_config.d/99-aera-internal-beta.conf
  /usr/sbin/sshd -t
  reload_ssh_service
  unlink "$marker"
  printf 'Password SSH and direct root SSH are disabled; cloud console recovery remains available.\n'
}

case "${1:-}" in
  prepare)
    shift
    prepare_host "$@"
    ;;
  verify-key-login)
    shift
    verify_key_login "$@"
    ;;
  rotate-password)
    shift
    rotate_account_password "$@"
    ;;
  harden-ssh)
    shift
    harden_ssh "$@"
    ;;
  *)
    fail 'usage: bootstrap-host.sh prepare|verify-key-login|rotate-password|harden-ssh'
    ;;
esac
