---
"@resciencelab/agent-world-network": major
---

refactor!: remove bootstrap nodes — Gateway absorbs registry

World Servers now announce directly to the Gateway via GATEWAY_URL,
eliminating the standalone bootstrap/registry layer. The Gateway's
existing peer infrastructure (/peer/announce, peer DB, /worlds) handles
all world discovery.

BREAKING CHANGE: The `bootstrapUrl` and `discoveryIntervalMs` config
fields are replaced by `gatewayUrls` and `announceIntervalMs`. World
Servers must set GATEWAY_URL instead of BOOTSTRAP_URL. The bootstrap/
directory, docs/bootstrap.json, and bootstrap-health workflow are removed.
