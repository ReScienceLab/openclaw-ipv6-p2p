# Yggdrasil Installation Guide

Yggdrasil is a lightweight, end-to-end encrypted IPv6 overlay network.
After install, restart the OpenClaw gateway — the plugin detects the daemon automatically.

---

## Recommended: Automated Setup

The setup script handles binary installation, config generation (with TCP admin
endpoint to avoid permission issues), public peer injection, and daemon startup:

```bash
openclaw p2p setup
```

Or run directly:
```bash
curl -fsSL https://raw.githubusercontent.com/ReScienceLab/DeClaw/main/scripts/setup-yggdrasil.sh | sudo bash
```

This works on **macOS** (arm64/amd64) and **Linux** (Debian/Ubuntu/Arch/tarball).

---

## Manual Install

### macOS

> **Note:** `brew install yggdrasil` uses a .pkg that may be blocked by Gatekeeper.
> The setup script above handles this automatically by extracting the binary directly.

```bash
brew install yggdrasil
```

If `which yggdrasil` returns nothing after brew install, Gatekeeper blocked it.
Run `openclaw p2p setup` instead.

### Linux — Debian / Ubuntu

```bash
sudo mkdir -p /usr/local/apt-keys
gpg --fetch-keys https://neilalexander.s3.dualstack.eu-west-2.amazonaws.com/deb/key.txt
gpg --export 1C5162E133015D81A811239D1840CDAC6011C5EA | sudo tee /usr/local/apt-keys/yggdrasil-keyring.gpg > /dev/null
echo 'deb [signed-by=/usr/local/apt-keys/yggdrasil-keyring.gpg] http://neilalexander.s3.dualstack.eu-west-2.amazonaws.com/deb/ debian yggdrasil' \
  | sudo tee /etc/apt/sources.list.d/yggdrasil.list
sudo apt-get update && sudo apt-get install yggdrasil
```

### Linux — Arch

```bash
yay -S yggdrasil
```

### Linux — Manual

```bash
# Download from https://github.com/yggdrasil-network/yggdrasil-go/releases/latest
tar -xzf yggdrasil-*.tar.gz
sudo mv yggdrasil yggdrasilctl /usr/local/bin/
```

### Docker

```dockerfile
docker run --cap-add=NET_ADMIN --device=/dev/net/tun ...
```

---

## After Install

1. Restart the OpenClaw gateway:
   ```bash
   launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
   ```
2. The plugin detects the daemon and obtains your `200::/8` address.
3. Use `yggdrasil_check` tool or `openclaw p2p status` to verify.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `which yggdrasil` returns nothing | Gatekeeper blocked it (macOS). Run `openclaw p2p setup`. |
| Binary found but daemon not detected | Admin socket permission denied. Run `openclaw p2p setup` to switch to TCP admin. |
| Binary found, daemon running, still not detected | Restart the gateway: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway` |
| Linux: permission denied on TUN | Needs `CAP_NET_ADMIN`. Run as root or `sudo setcap cap_net_admin+ep $(which yggdrasil)`. |
| Docker: no TUN device | Add `--cap-add=NET_ADMIN --device=/dev/net/tun` to container. |
