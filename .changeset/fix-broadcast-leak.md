---
"@resciencelab/agent-world-network": patch
---

fix(sdk): restrict world.state broadcasts to active world members only

`broadcastWorldState()` previously used `peerDb.values()` as broadcast targets, leaking
live world state to any discovered peer — even those that never joined the world. The
broadcast now filters through `agentEndpoints` and `agentLastSeen` so only agents that
successfully called `world.join` receive world state updates.
