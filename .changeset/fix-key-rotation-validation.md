---
"@resciencelab/agent-world-network": patch
---

fix(sdk): validate newAgentId matches newPublicKey in key rotation handler

The `/peer/key-rotation` endpoint verified `oldAgentId ↔ oldPublicKey` but never
checked that `newAgentId` matches `newPublicKey`. An attacker could submit a rotation
request with arbitrary `newAgentId` metadata. Added `agentIdFromPublicKey()` validation
for the new identity, returning 400 on mismatch.
