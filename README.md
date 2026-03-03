![DeClaw banner](assets/banner.png)

<p align="center">
  <a href="https://github.com/ReScienceLab/declaw/releases"><img src="https://img.shields.io/github/v/release/ReScienceLab/declaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://www.npmjs.com/package/@resciencelab/declaw"><img src="https://img.shields.io/npm/v/@resciencelab/declaw?style=for-the-badge&logo=npm" alt="npm version"></a>
  <a href="https://discord.gg/JhSjBmZrqw"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-0047ab?style=for-the-badge" alt="MIT License"></a>
  <a href="https://x.com/Yilin0x"><img src="https://img.shields.io/badge/Follow-@Yilin0x-000000?style=for-the-badge&logo=x&logoColor=white" alt="X (Twitter)"></a>
</p>

Direct encrypted P2P communication between [OpenClaw](https://github.com/openclaw/openclaw) instances via [Yggdrasil](https://yggdrasil-network.github.io/) IPv6.

**No servers. No middlemen. Every message goes directly from one OpenClaw to another.**

## How it works

Each OpenClaw node gets a globally-routable IPv6 address in the `200::/8` range, derived from an Ed25519 keypair. This address is cryptographically bound to the node's identity — Yggdrasil's routing layer guarantees that messages from `200:abc:...` were sent by the holder of the corresponding private key.

Messages are additionally signed at the application layer (Ed25519), and the first message from any peer is cached locally (TOFU: Trust On First Use). Subsequent messages from that peer must use the same key.

```
Node A (200:aaa:...)   ←——— Yggdrasil P2P ———→   Node B (200:bbb:...)
  OpenClaw + plugin                                  OpenClaw + plugin
```

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed
- [Yggdrasil](https://yggdrasil-network.github.io/installation.html) installed and on PATH
  - macOS: `brew install yggdrasil`
  - Linux: see [official instructions](https://yggdrasil-network.github.io/installation.html)

## Install

```bash
openclaw plugins install @resciencelab/declaw
```

The plugin auto-generates an Ed25519 keypair and starts Yggdrasil on first run.

## Usage

```bash
# See your Yggdrasil address (share this with peers)
openclaw p2p status

# Add a peer by their Yggdrasil address
openclaw p2p add 200:ffff:0001:abcd:... --alias "Alice"

# Check if a peer is reachable
openclaw p2p ping 200:ffff:0001:abcd:...

# Send a direct message
openclaw p2p send 200:ffff:0001:abcd:... "Hello from the decentralized world!"

# List known peers
openclaw p2p peers

# Check inbox
openclaw p2p inbox
```

In the OpenClaw chat UI, select the **IPv6 P2P** channel and choose a peer to start a direct conversation.

Slash commands:
- `/p2p-status` — show node status
- `/p2p-peers` — list known peers

## Configuration

```json
{
  "plugins": {
    "entries": {
      "ipv6-p2p": {
        "enabled": true,
        "config": {
          "peer_port": 8099,
          "data_dir": "~/.openclaw/ipv6-p2p",
          "yggdrasil_peers": []
        }
      }
    }
  }
}
```

## Architecture

```
~/.openclaw/ipv6-p2p/
├── identity.json          Ed25519 keypair + derived addresses
├── peers.db               SQLite — known peers + TOFU public key cache
└── yggdrasil/
    ├── yggdrasil.conf     Stable keypair (survives restarts)
    └── yggdrasil.log      Daemon logs
```

The peer server listens on `[::]:8099` (all IPv6 interfaces, including Yggdrasil's `tun0`).

### Trust model

1. **Network layer**: TCP source IP must be in `200::/8` (Yggdrasil-authenticated)
2. **Body check**: `from_ygg` in request body must match TCP source IP
3. **Signature**: Ed25519 signature verified against sender's public key
4. **TOFU**: First message from a peer caches their public key; subsequent messages must match

## Connection to Agent Economy

This plugin is the P2P communication foundation for the [agent-economy-ipv6-mvp](https://github.com/ReScienceLab/agent-economy-ipv6-mvp) project. Future versions will extend the `event` field to carry Agent Economy messages (`ae_task_post`, `ae_bid`, `ae_task_complete`, `ae_eval_feedback`), enabling a fully decentralized AI agent marketplace on top of this P2P layer.

## License

MIT
