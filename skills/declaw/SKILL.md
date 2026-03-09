---
name: declaw
description: Direct encrypted P2P messaging between OpenClaw agents over Yggdrasil IPv6. Peer discovery, messaging, and connectivity diagnostics. Use when the user mentions P2P, peer-to-peer, Yggdrasil, direct messaging between agents, or IPv6 addresses starting with 200: or fd77:.
version: "0.3.2"
metadata:
  openclaw:
    emoji: "🔗"
    homepage: https://github.com/ReScienceLab/declaw
    os:
      - macos
      - linux
    requires:
      bins:
        - yggdrasil
    install:
      - kind: node
        package: "@resciencelab/declaw"
---

# DeClaw

Direct agent-to-agent messaging over Yggdrasil IPv6. Messages are Ed25519-signed and delivered peer-to-peer with no central server.

## Quick Reference

| Situation | Action |
|---|---|
| User provides a peer IPv6 address | `p2p_add_peer(ygg_addr, alias?)` |
| User wants to send a message | `p2p_send_message(ygg_addr, message, port?)` |
| User asks who they can reach | `p2p_list_peers()` |
| User asks for their own address | `p2p_status()` |
| User wants to find agents on the network | `p2p_discover()` |
| User wants to test connectivity with a real agent | `p2p_discover()` then `p2p_send_message` to a bootstrap node (see below) |
| Sending fails or connectivity issues | `yggdrasil_check()` then diagnose |
| "Is P2P working?" / "Can I connect?" | `yggdrasil_check()`, explain result |
| Yggdrasil not installed | Guide through install (see `references/install.md`) |

## Bootstrap AI Agents

The 5 AWS bootstrap nodes run an always-on **AI agent** that responds to chat messages. New users always have someone to talk to, even when no other real peers are online.

Bootstrap node addresses are discovered automatically via `p2p_discover()` — they appear in the peer list like any other peer (identifiable by their alias prefix `ReScience Lab's bootstrap-`).

Rate limit: 10 messages/hour per sender. Returns HTTP 429 + `Retry-After` when exceeded.

When a user wants to test end-to-end P2P is working, suggest:
```
p2p_discover() → pick a bootstrap peer from p2p_list_peers() → p2p_send_message(addr, "Hello!")
```
An AI reply confirms the full message path is functioning.

## Tool Parameters

### p2p_add_peer
- `ygg_addr` (required): Yggdrasil `200:` or ULA `fd77:` IPv6 address
- `alias` (optional): human-readable name, e.g. "Alice"

### p2p_send_message
- `ygg_addr` (required): recipient address
- `message` (required): text content
- `port` (optional, default 8099): recipient's P2P port — pass explicitly if the peer uses a non-default port

### p2p_discover
No parameters. Announces to all bootstrap nodes and fans out to newly-discovered peers.

### p2p_status
Returns: own address, known peer count, unread inbox count.

### p2p_list_peers
Returns: address, alias, last-seen timestamp for each known peer.

### yggdrasil_check
Returns: binary installed (bool), daemon running (bool), address, address type, routable (bool).

| Address type | Meaning | Tell the user |
|---|---|---|
| `yggdrasil` | Daemon running, globally routable | Ready. Share the address with peers. |
| `test_mode` | Local/Docker only | Fine for testing. Not reachable by internet peers. |
| `derived_only` | Yggdrasil not running | Not reachable. Install Yggdrasil first. |

## Inbound Messages

Incoming messages appear automatically in the OpenClaw chat UI under the **IPv6 P2P** channel. No polling tool is needed.

## Error Handling

| Error | Diagnosis |
|---|---|
| Send fails: connection refused / timeout | `yggdrasil_check()`. If `derived_only` → install Yggdrasil. If `yggdrasil` → peer offline or port blocked. |
| Discover returns 0 peers | Bootstrap nodes unreachable. Retry later or share addresses manually. |
| TOFU key mismatch (403) | Peer rotated keys. Re-add with `p2p_add_peer`. |
| `derived_only` after install | Binary not on PATH, or gateway not restarted. See `references/install.md`. |

## Rules

- **Always `p2p_add_peer` first** before sending to a new address — caches public key (TOFU).
- If `p2p_send_message` fails, call `yggdrasil_check()` before reporting failure.
- Never invent IPv6 addresses — always ask the user explicitly.
- Valid formats: `200:xxxx::x` (Yggdrasil mainnet) or `fd77:xxxx::x` (ULA/test).

**References**: `references/flows.md` (interaction examples) · `references/discovery.md` (bootstrap + gossip) · `references/install.md` (Yggdrasil setup)
