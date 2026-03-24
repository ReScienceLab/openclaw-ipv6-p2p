#!/usr/bin/env bash
set -euo pipefail

REPO="ReScienceLab/agent-world-network"
BINARY="awn"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

info()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
error() { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux*)  os="unknown-linux-gnu" ;;
    Darwin*) os="apple-darwin" ;;
    *)       error "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *)             error "Unsupported architecture: $arch" ;;
  esac

  echo "${arch}-${os}"
}

get_latest_version() {
  local tag
  tag="$(curl -sL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -o '"tag_name": *"[^"]*"' \
    | head -1 \
    | grep -o '"v[^"]*"' \
    | tr -d '"v')"
  echo "$tag"
}

main() {
  local version="${VERSION:-}"
  local target
  target="$(detect_target)"

  if [ -z "$version" ]; then
    info "Fetching latest release..."
    version="$(get_latest_version)"
  fi

  [ -z "$version" ] && error "Could not determine version. Set VERSION=x.y.z manually."

  local url="https://github.com/${REPO}/releases/download/v${version}/${BINARY}-v${version}-${target}.tar.gz"
  local tmp
  tmp="$(mktemp -d)"
  trap "rm -rf '$tmp'" EXIT

  info "Downloading awn v${version} for ${target}..."
  curl -fsSL "$url" -o "${tmp}/awn.tar.gz" || error "Download failed. Check that v${version} has a binary for ${target}."

  info "Extracting..."
  tar xzf "${tmp}/awn.tar.gz" -C "$tmp"

  mkdir -p "$INSTALL_DIR"
  info "Installing to ${INSTALL_DIR}..."
  cp "${tmp}/${BINARY}-v${version}-${target}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  chmod +x "${INSTALL_DIR}/${BINARY}"

  info "Done! awn v${version} installed to ${INSTALL_DIR}/${BINARY}"
  "${INSTALL_DIR}/${BINARY}" --version

  # Hint if INSTALL_DIR is not in PATH
  case ":$PATH:" in
    *":${INSTALL_DIR}:"*) ;;
    *) info "Add ${INSTALL_DIR} to your PATH: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
  esac
}

main "$@"
