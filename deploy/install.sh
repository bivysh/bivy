#!/usr/bin/env bash
# Standalone Linux bootstrap. Published as a stable GitHub release asset.
set -euo pipefail
umask 077

INSTALL_DOCKER=0
if [[ "${1:-}" == "--install-docker" ]]; then INSTALL_DOCKER=1; shift; fi
DOMAIN="${1:-}"
RELAY_DOMAIN="${2:-$DOMAIN}"
if [[ -z "$DOMAIN" || "$DOMAIN" == --help || $# -gt 2 ]]; then
  echo "Usage: bash install.sh [--install-docker] <app-domain> [relay-domain]"
  echo "Set BIVY_SELF_HOST_VERSION=vX.Y.Z to select a stable release."
  echo "Set BIVY_SELF_HOST_DIR to change the installation directory."
  exit 1
fi
[[ "$(uname -s)" == Linux ]] || { echo "Run this installer on your Linux VPS." >&2; exit 1; }
case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) echo "Supported architectures: AMD64 and ARM64." >&2; exit 1 ;; esac

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  if [[ "$INSTALL_DOCKER" != 1 ]]; then
    if [[ -t 1 && -r /dev/tty ]]; then
      printf 'Docker Engine + Compose are required. Install from Docker’s official apt repository? [y/N] ' > /dev/tty
      read -r answer < /dev/tty
      if [[ "$answer" == y || "$answer" == Y ]]; then INSTALL_DOCKER=1; fi
    fi
  fi
  [[ "$INSTALL_DOCKER" == 1 ]] || { echo "Install Docker Engine + Compose, or rerun with --install-docker (Debian/Ubuntu, root required)." >&2; exit 1; }
  [[ "$EUID" == 0 ]] || { echo "Docker installation requires root. Inspect this script, then rerun with sudo." >&2; exit 1; }
  source /etc/os-release
  case "$ID" in debian|ubuntu) ;; *) echo "Automatic Docker installation supports Debian/Ubuntu only." >&2; exit 1 ;; esac
  apt-get update
  apt-get install -y ca-certificates curl gnupg openssl
  install -m 0755 -d /etc/apt/keyrings
  key="$(mktemp)"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$ID/gpg" -o "$key"
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg "$key"
  rm -f "$key"
  chmod a+r /etc/apt/keyrings/docker.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
for tool in curl tar sha256sum openssl getent; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool. Install it and rerun." >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "Docker is not running or this user lacks Docker access. Run as a Docker administrator." >&2; exit 1; }

# Catch common preparation mistakes before downloading images. Public HTTPS
# checks after startup are authoritative (including certificate and AAAA issues).
for domain in "$DOMAIN" "$RELAY_DOMAIN"; do
  [[ "$domain" =~ ^[A-Za-z0-9.-]+$ && "$domain" == *.* ]] || { echo "Supply DNS hostnames, not URLs or paths." >&2; exit 1; }
  getent ahosts "$domain" >/dev/null || { echo "DNS does not resolve $domain. Point its A/AAAA record at this server and retry." >&2; exit 1; }
done
if [[ -r /proc/meminfo ]]; then
  memory_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  if [[ "$memory_kb" -lt 1900000 ]]; then echo "Warning: 2 GB RAM is recommended for the bundled stack." >&2; fi
fi
if command -v ss >/dev/null && ! docker ps --format '{{.Names}}' | grep -q 'caddy'; then
  if ss -H -ltn '( sport = :80 or sport = :443 )' | grep -q .; then
    echo "Ports 80/443 are already in use. Free them or configure your existing reverse proxy using the advanced deployment docs." >&2
    exit 1
  fi
fi

BASE=https://github.com/bivysh/bivy/releases
VERSION="${BIVY_SELF_HOST_VERSION:-}"
if [[ -z "$VERSION" ]]; then
  resolved="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output /dev/null --write-out '%{url_effective}' "$BASE/latest")"
  VERSION="${resolved##*/}"
fi
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Choose a published stable version such as vX.Y.Z." >&2; exit 1; }
ROOT="${BIVY_SELF_HOST_DIR:-${HOME}/bivy-self-host}"
if [[ "$EUID" == 0 && -z "${BIVY_SELF_HOST_DIR:-}" ]]; then ROOT=/opt/bivy; fi
[[ ! -e "$ROOT/.git" ]] || { echo "Refusing to overwrite a source checkout at $ROOT." >&2; exit 1; }
if [[ -e "$ROOT/deploy/.env" && ! -f "$ROOT/deploy/RELEASE_IMAGE_TAG" ]]; then
  echo "Existing deployment is not a release bundle. Upgrade it with its existing self-host.sh." >&2; exit 1
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for file in bivy-self-host.tar.gz bivy-self-host.tar.gz.sha256; do
  if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$BASE/download/$VERSION/$file" -o "$TMP/$file"; then
    echo "Release $VERSION has no downloadable self-host bundle (older releases may predate it). No deployment files were changed." >&2
    exit 1
  fi
done
expected="$(awk '{print $1}' "$TMP/bivy-self-host.tar.gz.sha256")"
actual="$(sha256sum "$TMP/bivy-self-host.tar.gz")"; actual="${actual%% *}"
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$actual" == "$expected" ]] || { echo "Self-host bundle checksum mismatch. Refusing to install." >&2; exit 1; }
mkdir "$TMP/bundle"
tar -xzf "$TMP/bivy-self-host.tar.gz" -C "$TMP/bundle" --no-same-owner
pin="$(< "$TMP/bundle/deploy/RELEASE_IMAGE_TAG")"
[[ "$pin" =~ ^[a-f0-9]{40}$ ]] || { echo "Bundle is missing its immutable image pin." >&2; exit 1; }
[[ "$(< "$TMP/bundle/deploy/RELEASE_VERSION")" == "$VERSION" ]] || { echo "Bundle version does not match the requested release." >&2; exit 1; }
mkdir -p "$ROOT/deploy"
# Atomic replacement keeps a running install/manage shell on its old inode.
# Never copy .env or replace an operator's Caddyfile.
for file in self-host.sh manage.sh common.sh install.sh docker-compose.yml docker-compose.hosted-db.yml RELEASE_IMAGE_TAG RELEASE_VERSION README.md control-plane.env.example relay.env.example; do
  install -m 600 "$TMP/bundle/deploy/$file" "$ROOT/deploy/.$file.new"
  mv "$ROOT/deploy/.$file.new" "$ROOT/deploy/$file"
done
if [[ ! -f "$ROOT/deploy/Caddyfile" ]]; then cp "$TMP/bundle/deploy/Caddyfile" "$ROOT/deploy/Caddyfile"; fi
for file in LICENSE NOTICE; do cp "$TMP/bundle/$file" "$ROOT/$file"; done
mkdir -p "$ROOT/docs"
for file in self-host.md self-host-quickstart.md github-oauth-setup.md deploy-images.md; do
  cp "$TMP/bundle/docs/$file" "$ROOT/docs/$file"
done
echo "Installing Bivy $VERSION in $ROOT"
# Explicitly bind config to this bundle even if the invoking shell has an old
# image override. Source-build users use self-host.sh directly instead.
BIVY_IMAGE_TAG="$pin" bash "$ROOT/deploy/self-host.sh" "$DOMAIN" "$RELAY_DOMAIN"
