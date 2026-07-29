#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'desktop update publish failed: %s\n' "$1" >&2
  exit 1
}

umask 077

if [[ ${SSH_ORIGINAL_COMMAND:-publish} != publish ]]; then
  fail "unsupported command"
fi
if (($# != 0)); then
  fail "arguments are not accepted"
fi

channel_root=${AERA_DESKTOP_UPDATE_ROOT:-/var/lib/aera/desktop-updates/internal-beta}
public_key=${AERA_DESKTOP_UPDATE_PUBLIC_KEY:-/usr/local/share/aera/desktop-update-signing-public.pem}
base_url=${AERA_DESKTOP_UPDATE_BASE_URL:-https://47.100.169.193/desktop-updates/internal-beta}
key_id=${AERA_DESKTOP_UPDATE_KEY_ID:-desktop-update-2026-07}
maximum_bytes=${AERA_DESKTOP_UPDATE_MAXIMUM_BYTES:-2147483648}

[[ $maximum_bytes =~ ^[1-9][0-9]*$ ]] || fail "maximum bundle size is invalid"
[[ -f $public_key ]] || fail "trusted public key is unavailable"
mkdir -p "$channel_root"
chmod 0755 "$channel_root"

temporary_root=$(mktemp -d "$channel_root/.incoming.XXXXXX")
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

bundle="$temporary_root/bundle.tar"
head -c "$((maximum_bytes + 1))" > "$bundle"
bundle_size=$(wc -c < "$bundle" | tr -d ' ')
((bundle_size > 0)) || fail "empty bundle"
((bundle_size <= maximum_bytes)) || fail "bundle exceeds the size limit"

listing="$temporary_root/listing"
tar -tf "$bundle" > "$listing"
[[ $(wc -l < "$listing" | tr -d ' ') == 4 ]] ||
  fail "bundle must contain exactly four files"
[[ $(LC_ALL=C sort "$listing" | uniq | wc -l | tr -d ' ') == 4 ]] ||
  fail "bundle contains duplicate paths"
while IFS= read -r path; do
  [[ $path != /* && $path != *".."* && $path != *"\\"* ]] ||
    fail "bundle contains an unsafe path"
  [[ $path == manifest.json ||
    $path == manifest.sig ||
    $path =~ ^releases/[0-9]+\.[0-9]+\.[0-9]+-internal-beta\.[1-9][0-9]*/Aera-Internal-Beta-[A-Za-z0-9._-]+$ ]] ||
    fail "bundle contains an unexpected path"
done < "$listing"
while IFS= read -r mode _rest; do
  [[ ${mode:0:1} == "-" ]] || fail "bundle entries must be regular files"
done < <(tar -tvf "$bundle")

extracted="$temporary_root/extracted"
mkdir -p "$extracted"
tar -xf "$bundle" -C "$extracted"

validation_output="$temporary_root/validated"
signature_raw="$temporary_root/signature.raw"
python3 - \
  "$extracted" \
  "$base_url" \
  "$key_id" \
  "$validation_output" \
  "$signature_raw" <<'PY'
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
base_url = sys.argv[2]
expected_key_id = sys.argv[3]
output_path = Path(sys.argv[4])
signature_path = Path(sys.argv[5])

version_pattern = re.compile(
    r"^[0-9]+\.[0-9]+\.[0-9]+-internal-beta\.[1-9][0-9]*$"
)
sha256_pattern = re.compile(r"^[0-9a-f]{64}$")
sha512_pattern = re.compile(r"^[A-Za-z0-9+/]{86}==$")

def canonical_bytes(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

def read_canonical(path, fields, label):
    raw = path.read_bytes()
    try:
        value = json.loads(raw)
    except Exception as error:
        raise SystemExit(f"{label} JSON is invalid: {error}")
    if not isinstance(value, dict) or sorted(value) != sorted(fields):
        raise SystemExit(f"{label} fields differ")
    if canonical_bytes(value) != raw:
        raise SystemExit(f"{label} is not canonical JSON")
    return value

manifest = read_canonical(
    root / "manifest.json",
    [
        "artifacts",
        "channel",
        "key_id",
        "published_at",
        "release_notes",
        "schema_version",
        "version",
    ],
    "manifest",
)
version = manifest["version"]
if (
    manifest["schema_version"] != 1
    or manifest["channel"] != "internal-beta"
    or manifest["key_id"] != expected_key_id
    or not isinstance(version, str)
    or not version_pattern.fullmatch(version)
    or not isinstance(manifest["release_notes"], str)
    or not 0 < len(manifest["release_notes"]) <= 2000
):
    raise SystemExit("manifest identity is invalid")

expected = [
    (
        "darwin",
        "arm64",
        "zip",
        f"Aera-Internal-Beta-{version}-macos-arm64.zip",
    ),
    (
        "win32",
        "x64",
        "nsis",
        f"Aera-Internal-Beta-{version}-windows-x64-setup.exe",
    ),
]
artifacts = manifest["artifacts"]
if not isinstance(artifacts, list) or len(artifacts) != 2:
    raise SystemExit("manifest artifacts are incomplete")
for index, specification in enumerate(expected):
    artifact = artifacts[index]
    if not isinstance(artifact, dict) or sorted(artifact) != sorted(
        ["arch", "kind", "name", "platform", "sha256", "sha512", "size", "url"]
    ):
        raise SystemExit("artifact fields differ")
    platform, arch, kind, name = specification
    expected_url = f"{base_url}/releases/{version}/{name}"
    if (
        artifact["platform"] != platform
        or artifact["arch"] != arch
        or artifact["kind"] != kind
        or artifact["name"] != name
        or artifact["url"] != expected_url
        or not isinstance(artifact["size"], int)
        or artifact["size"] <= 0
        or not isinstance(artifact["sha256"], str)
        or not sha256_pattern.fullmatch(artifact["sha256"])
        or not isinstance(artifact["sha512"], str)
        or not sha512_pattern.fullmatch(artifact["sha512"])
    ):
        raise SystemExit("artifact identity is invalid")
    path = root / "releases" / version / name
    if not path.is_file() or path.is_symlink():
        raise SystemExit("artifact file is unavailable")
    sha256 = hashlib.sha256()
    sha512 = hashlib.sha512()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            size += len(chunk)
            sha256.update(chunk)
            sha512.update(chunk)
    if (
        size != artifact["size"]
        or sha256.hexdigest() != artifact["sha256"]
        or base64.b64encode(sha512.digest()).decode("ascii") != artifact["sha512"]
    ):
        raise SystemExit("artifact bytes differ from signed metadata")

envelope = read_canonical(
    root / "manifest.sig",
    ["algorithm", "key_id", "schema_version", "signature_base64"],
    "signature",
)
if (
    envelope["schema_version"] != 1
    or envelope["key_id"] != expected_key_id
    or envelope["algorithm"] != "Ed25519"
    or not isinstance(envelope["signature_base64"], str)
):
    raise SystemExit("signature identity is invalid")
try:
    signature = base64.b64decode(envelope["signature_base64"], validate=True)
except Exception as error:
    raise SystemExit(f"signature encoding is invalid: {error}")
if len(signature) != 64:
    raise SystemExit("signature length is invalid")
signature_path.write_bytes(signature)
output_path.write_text(version, encoding="ascii")
PY

version=$(cat "$validation_output")
openssl pkeyutl -verify \
  -pubin \
  -inkey "$public_key" \
  -rawin \
  -in "$extracted/manifest.json" \
  -sigfile "$signature_raw" >/dev/null ||
  fail "metadata signature is invalid"

current_manifest="$channel_root/current/manifest.json"
if [[ -f $current_manifest ]]; then
  current_version=$(python3 - "$current_manifest" <<'PY'
import json
import sys
print(json.loads(open(sys.argv[1], encoding="utf-8").read())["version"])
PY
)
  ordering=$(python3 - "$current_version" "$version" <<'PY'
import re
import sys

def parts(value):
    match = re.fullmatch(
        r"([0-9]+)\.([0-9]+)\.([0-9]+)-internal-beta\.([1-9][0-9]*)",
        value,
    )
    if not match:
        raise SystemExit("stored version is invalid")
    return tuple(map(int, match.groups()))

left, right = parts(sys.argv[1]), parts(sys.argv[2])
print(-1 if right < left else 0 if right == left else 1)
PY
)
  ((ordering >= 0)) || fail "release would downgrade the update channel"
  if ((ordering == 0)); then
    cmp -s "$extracted/manifest.json" "$channel_root/current/manifest.json" &&
      cmp -s "$extracted/manifest.sig" "$channel_root/current/manifest.sig" ||
      fail "published version is immutable"
    while IFS= read -r name; do
      cmp -s \
        "$extracted/releases/$version/$name" \
        "$channel_root/releases/$version/$name" ||
        fail "published artifact is immutable"
    done < <(
      printf '%s\n' \
        "Aera-Internal-Beta-$version-macos-arm64.zip" \
        "Aera-Internal-Beta-$version-windows-x64-setup.exe"
    )
    printf 'desktop update already published: %s\n' "$version"
    exit 0
  fi
fi

release_target="$channel_root/releases/$version"
channel_target="$channel_root/versions/$version"
[[ ! -e $release_target && ! -e $channel_target ]] ||
  fail "target version already exists"
mkdir -p "$channel_root/releases" "$channel_root/versions"
chmod 0755 "$channel_root/releases" "$channel_root/versions"

chmod 0644 "$extracted/manifest.json" "$extracted/manifest.sig"
find "$extracted/releases/$version" -type f -exec chmod 0644 {} +
mv "$extracted/releases/$version" "$release_target"
mkdir "$channel_target"
chmod 0755 "$channel_target" "$release_target"
mv "$extracted/manifest.json" "$extracted/manifest.sig" "$channel_target/"

next_link="$channel_root/.current-$version-$$"
ln -s "versions/$version" "$next_link"
python3 - "$next_link" "$channel_root/current" <<'PY'
import os
import sys
os.replace(sys.argv[1], sys.argv[2])
PY

printf 'desktop update published: %s\n' "$version"
