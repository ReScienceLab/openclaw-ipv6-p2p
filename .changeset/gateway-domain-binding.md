---
"@resciencelab/agent-world-network": patch
---

Bind gateway to https://gateway.agentsworlds.ai: add Cloudflare DNS upsert step to deploy-gateway workflow (proxied=true for automatic HTTPS via Cloudflare), expose HTTP API on port 80, inject PUBLIC_URL/PUBLIC_ADDR into the container. Centralise the gateway URL in package.json gateway.url and propagate it via sync-version.mjs to src/index.ts, web/client.js, and docs/index.html. The deploy workflow reads GATEWAY_URL from GitHub Actions vars with a fallback, so the domain can be overridden without touching code. Also fixes skills/awn/SKILL.md os value from macos to darwin.
