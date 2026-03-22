---
"@resciencelab/agent-world-network": patch
---

fix(sdk): protocol consistency — domain separator, ledger constant, Fastify reply

- **Domain separator mismatch:** `broadcastWorldState()` body signature changed from
  `DOMAIN_SEPARATORS.WORLD_STATE` to `DOMAIN_SEPARATORS.MESSAGE` to match the
  `/peer/message` receiver verification.
- **Ledger dead code:** Removed unused `LEDGER_DOMAIN` constant. Replaced fragile
  string-splitting `LEDGER_SEPARATOR` construction with direct `PROTOCOL_VERSION` usage.
- **Fastify reply:** Added explicit `return reply.send(body)` in `/peer/message` handler
  to follow Fastify 5 async handler best practices.
