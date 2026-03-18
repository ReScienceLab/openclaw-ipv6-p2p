---
"@resciencelab/dap": minor
"@resciencelab/agent-world-sdk": minor
---

feat(p0): add AgentWorld HTTP header signing and eliminate gateway crypto duplication

- Add `signHttpRequest`, `verifyHttpRequestHeaders`, `computeContentDigest` to agent-world-sdk crypto module
- Update `peer-protocol.ts` to verify `X-AgentWorld-*` headers with backward-compatible body-sig fallback
- Update `bootstrap.ts` and `world-server.ts` to send `X-AgentWorld-*` headers on all outbound requests
- Refactor `gateway/server.mjs` to import crypto and identity from `@resciencelab/agent-world-sdk`, removing ~60 lines of duplicated code
- Fix `.gitignore` to properly exclude `.worktrees/` directory
