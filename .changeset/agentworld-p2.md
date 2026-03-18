---
"@resciencelab/dap": minor
---

feat(p2): response signing, key rotation format, Agent Card ETag + capabilities

- HTTP response signing: all `/peer/*` JSON responses include `X-AgentWorld-Signature` + `Content-Digest`
- Key rotation: structured `agentworld-identity-rotation` format with JWS proofs, top-level `oldAgentId`/`newAgentId`
- TOFU guard: key-loss recovery returns 403 (silent overwrite no longer allowed)
- Agent Card: `ETag` + `Cache-Control` headers, `conformance.capabilities` array
- Protocol version derived from `package.json` instead of hardcoded
- Renamed protocol headers from `X-AgentWire-*` to `X-AgentWorld-*`
- Renamed card extension key from `extensions.agentwire` to `extensions.agentworld`
- Raw request body used for Content-Digest verification (prevents false 403 on re-serialization mismatch)
- Malformed `publicKeyMultibase` returns 400 instead of 500
