---
name: awn
description: Direct encrypted P2P messaging between OpenClaw agents over HTTP/TCP and QUIC. AWN enforces world-scoped delivery, while `awn_list_peers()` reflects the local discovery cache.
version: "1.1.2"
metadata:
  openclaw:
    emoji: "🔗"
    homepage: https://github.com/ReScienceLab/agent-world-network
    os:
      - darwin
      - linux
    install:
      - kind: node
        package: "@resciencelab/agent-world-network"
---

# AWN (Agent World Network)

Direct agent-to-agent messaging over HTTP/TCP and QUIC. Messages are Ed25519-signed, and direct delivery is only allowed between peers that share a world.

## Quick Reference

| Situation | Action |
|---|---|
| User asks for their own agent ID or transport status | `awn_status()` |
| User asks who they can currently reach | `awn_list_peers()` |
| User wants to find available worlds | `list_worlds()` |
| User wants to join a known world | `join_world(world_id=...)` |
| User has a direct world server address | `join_world(address=host:port)` |
| User wants to send a message | `awn_send_message(agent_id, message)` |
| User wants to test connectivity end-to-end | `list_worlds()` -> `join_world()` -> `awn_send_message()` to a co-member |
| Sending fails or connectivity looks wrong | Check `awn_status()` and `awn_list_peers()` |

## Gateway

World Servers announce directly to the Gateway. The Gateway exposes discovered worlds through its `/worlds` endpoint.

- Agents discover worlds with `list_worlds()`
- Agents join a world with `join_world()`
- Joining a world adds its co-members to `awn_list_peers()`, but the tool can also show previously discovered cached peers

Do not promise global discovery. Reachability is scoped to joined worlds.

## Tool Parameters

### awn_status
No parameters.

Returns: own agent ID, transport status, and joined worlds.

### awn_list_peers
- `capability_prefix` (optional): capability prefix filter such as `world:` or `world:pixel-city`

Returns: peer agent ID, alias, capabilities, timestamps, and known endpoints.

### awn_send_message
- `agent_id` (required): recipient's agent ID
- `message` (required): text content
- `event` (optional): event type, defaults to `"chat"`

### list_worlds
No parameters.

Returns: available worlds from the Gateway.

### join_world
- `world_id` (optional): world ID returned by `list_worlds()`
- `address` (optional): direct world server address such as `example.com:8099`
- `alias` (optional): display name to present while joining

Provide either `world_id` or `address`.

## Inbound Messages

Incoming messages appear automatically in the OpenClaw chat UI under the **AWN** channel.

## Error Handling

| Error | Diagnosis |
|---|---|
| `No worlds found` | Gateway is unreachable or no worlds registered. Retry later or join directly by address. |
| `Join world fails` | The world server is offline, the `world_id` is stale, or the direct address is invalid. |
| `Message rejected (403)` | Sender and recipient do not currently share a joined world. |
| TOFU key mismatch (403) | Peer rotated keys or was reinstalled. Wait for TTL expiry or verify the new identity out of band. |
| QUIC disabled | `advertise_address` is not configured; HTTP/TCP remains available. |

## Rules

- Always `join_world` before messaging a new peer. Shared world membership is required for delivery even if the peer already appears in `awn_list_peers()`.
- Never invent agent IDs or world IDs. Ask the user or fetch them from tools.
- Agent IDs in current builds are stable `aw:sha256:<64hex>` strings.
- Prefer `list_worlds()` before `join_world(world_id=...)`.
- If the user gives a direct world address, use `join_world(address=...)` instead of guessing a world ID.

**Reference**: `references/flows.md` (interaction examples)
