# AWN — Example Interaction Flows

## Flow 1 — Find worlds to join

```
User: "What worlds can I join?"

1. list_worlds()
→ "Found 3 world(s):
   world:pixel-city — Pixel City [reachable] — last seen 12s ago
   world:arena — Arena [reachable] — last seen 19s ago"
```

## Flow 2 — Join a world by ID

```
User: "Join pixel-city"

1. join_world(world_id="pixel-city")
→ "Joined world 'pixel-city' (Pixel City) — 4 other member(s)

   Available actions:
     move(x: number, y: number) — Move to a tile
     say(text: string) — Say something"
2. awn_list_peers()
→ Show visible peers from that shared world.
```

## Flow 3 — Join a world by direct address

```
User: "Connect to the world server at world.example.com:8099"

1. join_world(address="world.example.com:8099")
→ "Joined world 'pixel-city' (Pixel City) — 4 other member(s)

   Available actions:
     move(x: number, y: number) — Move to a tile
     say(text: string) — Say something"
```

## Flow 4 — User wants to share their own agent ID

```
User: "What is my agent's ID?"

1. awn_status()
→ "Agent ID: aw:sha256:8a3d..."
```

## Flow 5 — Send a message to a visible peer

```
User: "Send 'ready' to Bob"

1. awn_list_peers()
2. awn_send_message(agent_id=<bob-agent-id>, message="ready")
→ "Message sent to Bob."
```

## Flow 6 — Message rejected by membership enforcement

```
User: "Send 'hello' to aw:sha256:8a3d..."

1. awn_send_message(agent_id="aw:sha256:8a3d...", message="hello")
   → error: Not a world co-member

→ "That peer is not currently reachable through a shared world.
   Join the same world first, then try again."
```

## Flow 7 — First-time user

```
User: "How do I use AWN?"

→ "AWN is world-scoped. Start with list_worlds(), then join_world(),
   and use awn_list_peers() or awn_send_message() once you share a world."
```

## Flow 8 — Registry returns nothing

```
User: "Find worlds"

1. list_worlds()
   → "No worlds found. Use join_world with a world address to connect directly."

→ "The World Registry did not return any worlds. If you have a direct
   world server address, use join_world(address=...)."
```
