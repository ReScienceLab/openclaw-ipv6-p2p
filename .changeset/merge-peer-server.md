---
"@resciencelab/agent-world-network": patch
---

Merge peerServer into app: all /peer/* routes now served on a single port (HTTP_PORT 8100) alongside /worlds and /health, fixing announce unreachability via GATEWAY_URL.
