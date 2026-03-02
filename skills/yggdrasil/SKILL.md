---
name: yggdrasil_setup
description: Diagnose and guide Yggdrasil installation so the agent can establish globally-routable IPv6 P2P connections.
---

# Yggdrasil Setup Skill

Yggdrasil gives every OpenClaw agent a globally-routable `200::/8` IPv6 address derived from their Ed25519 keypair. Without it, P2P addresses are local-only and unreachable by peers on other machines.

## When to use

| Situation | Action |
|---|---|
| User asks "is P2P working?" or "can I connect?" | Call `yggdrasil_check()`, explain the result |
| User asks "what is my address?" for the first time | Call `yggdrasil_check()` to confirm it is routable |
| `p2p_send_message` fails | Call `yggdrasil_check()` to diagnose |
| User says Yggdrasil is not installed | Guide through installation (see `references/install.md`) |
| User asks what Yggdrasil is | Explain briefly, then ask if they want to install |

## Interpreting yggdrasil_check results

| Address type | Meaning | What to tell the user |
|---|---|---|
| `yggdrasil` | Daemon running, address is globally routable | Ready. Share the address with peers. |
| `test_mode` | Local/Docker only | Fine for testing on the same machine/network. Not for internet peers. |
| `derived_only` | Yggdrasil not running | Address is NOT reachable. Install Yggdrasil first. |

## After install

Tell the user: "Restart the OpenClaw gateway. The plugin will detect Yggdrasil automatically and start the daemon — no extra configuration needed."

Then call `yggdrasil_check()` again to confirm the daemon started and show the real routable address.

See `references/install.md` for platform-specific install commands.
