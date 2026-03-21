---
"@resciencelab/agent-world-network": minor
---

feat: Gateway persistence, graceful shutdown, and health observability

- Rename internal peers → registry terminology for clarity
- Persist world registry to $DATA_DIR/registry.json with atomic writes
- Wire persistence into announce and prune flows for restart recovery
- Stop /peer/message from polluting registry with empty records
- Add graceful shutdown (SIGTERM/SIGINT) that flushes registry state
- Enhance /health with registryAge, status (ready/warming/empty)
