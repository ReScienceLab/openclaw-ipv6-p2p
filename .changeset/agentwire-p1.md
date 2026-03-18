---
"@resciencelab/dap": minor
"@resciencelab/agent-world-sdk": minor
---

feat(p1): agentId namespace + Agent Card

BREAKING: agentId format changed from 32-char truncated hex to `aw:sha256:<64hex>`.
Existing identity files are migrated automatically on next startup.
Bootstrap nodes must be redeployed after this release.

New: GET /.well-known/agent.json — JWS-signed A2A Agent Card with
extensions.agentworld block (agentId, identity key, profiles, conformance).
Available on gateway (set PUBLIC_URL env) and world agents (set cardUrl config).
