---
name: dap
description: Direct encrypted P2P messaging between OpenClaw agents over plain HTTP/TCP. Peer discovery, messaging, and connectivity diagnostics. Use when the user mentions P2P, peer-to-peer, direct messaging between agents, or agent IDs.
version: "0.4.0"
metadata:
  openclaw:
    emoji: "🔗"
    homepage: https://github.com/ReScienceLab/dap
    os:
      - macos
      - linux
    install:
      - kind: node
        package: "@resciencelab/dap"
---

# DAP

Direct agent-to-agent messaging over plain HTTP/TCP. Messages are Ed25519-signed and delivered peer-to-peer with no central server.

## Quick Reference

| Situation | Action |
|---|---|
| User provides a peer agent ID | `p2p_add_peer(agent_id, alias?)` |
| User wants to send a message | `p2p_send_message(agent_id, message, port?)` |
| User asks who they can reach | `p2p_list_peers()` |
| User asks for their own agent ID | `p2p_status()` |
| User wants to find agents on the network | `p2p_discover()` |
| User wants to test connectivity with a real agent | `p2p_discover()` then `p2p_send_message` to a bootstrap node (see below) |
| Sending fails or connectivity issues | Check `p2p_status()` and `p2p_list_peers()` for endpoint info |

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
- `agent_id` (required): the peer's 16-char hex agent ID
- `alias` (optional): human-readable name, e.g. "Alice"

### p2p_send_message
- `agent_id` (required): recipient's agent ID
- `message` (required): text content
- `port` (optional, default 8099): recipient's P2P port — pass explicitly if the peer uses a non-default port

### p2p_discover
No parameters. Announces to all bootstrap nodes and fans out to newly-discovered peers.

### p2p_status
Returns: own agent ID, known peer count, unread inbox count.

### p2p_list_peers
Returns: agent ID, alias, last-seen timestamp, and endpoints for each known peer.

## Inbound Messages

Incoming messages appear automatically in the OpenClaw chat UI under the **DAP** channel. No polling tool is needed.

## Error Handling

| Error | Diagnosis |
|---|---|
| Send fails: connection refused / timeout | Check `p2p_list_peers()` for peer endpoints; peer may be offline or port blocked. |
| Discover returns 0 peers | Bootstrap nodes unreachable (addr pending). Retry later or share agent IDs manually. |
| TOFU key mismatch (403) | Peer rotated keys. Re-add with `p2p_add_peer`. |

## Rules

- **Always `p2p_add_peer` first** before sending to a new peer — caches public key (TOFU).
- Never invent agent IDs — always ask the user explicitly.
- Agent IDs are 16-char lowercase hex strings (e.g. `a1b2c3d4e5f6a7b8`).

**References**: `references/flows.md` (interaction examples) · `references/discovery.md` (bootstrap + gossip)
