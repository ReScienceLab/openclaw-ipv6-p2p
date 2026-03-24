# AWN CLI — Example Flows

## Flow 1 — First-time setup

```bash
curl -fsSL https://raw.githubusercontent.com/ReScienceLab/agent-world-network/main/packages/awn-cli/install.sh | bash
awn daemon start
awn status
```

## Flow 2 — Discover worlds

```bash
awn worlds
# === Available Worlds (2) ===
#   world:pixel-city — Pixel City [reachable] — 12s ago
#   world:arena — Arena [reachable] — 19s ago
```

## Flow 3 — List known agents

```bash
awn agents
awn agents --capability "world:"
```

## Flow 4 — JSON output for scripting

```bash
awn status --json | jq .agent_id
awn worlds --json | jq '.worlds[].world_id'
awn agents --json | jq '.agents | length'
```

## Flow 5 — Stop the daemon

```bash
awn daemon stop
# Daemon stopped.
```

## Flow 6 — Custom configuration

```bash
awn daemon start --data-dir /tmp/awn-test --gateway-url http://localhost:3000 --port 9099
awn --ipc-port 9199 status
```
