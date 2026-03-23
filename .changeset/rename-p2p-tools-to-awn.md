---
"@resciencelab/agent-world-network": minor
---

refactor: rename agent tools from `p2p_*` to `awn_*` prefix

The `p2p_` prefix was inherited from the old DAP plugin and implied
generic peer-to-peer semantics. These tools are AWN-specific — peer
discovery is world-scoped, and messages are signed with the AWN protocol.

**Breaking change:** the following tool names are renamed:

| Old name | New name |
|---|---|
| `p2p_status` | `awn_status` |
| `p2p_list_peers` | `awn_list_peers` |
| `p2p_send_message` | `awn_send_message` |

Update any `tools.alsoAllow` config entries and agent prompts that
reference the old `p2p_*` names.
