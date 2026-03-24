---
"@resciencelab/agent-world-network": patch
---

fix(gateway): add /peer/announce backward-compat route and auto-redeploy on SDK version bump

- Add `POST /peer/announce` backward-compat route for SDK < 1.4 world containers (returns legacy `{peers:[]}` shape)
- Raise default `STALE_TTL_MS` from 90 s to 15 min to prevent old SDK worlds (10 min announce interval, no heartbeat) from being pruned between announces
- Add `packages/agent-world-sdk/package.json` to `deploy-gateway.yml` path triggers so any SDK minor version bump automatically redeploys the gateway (fixes 403 signature mismatch caused by `PROTOCOL_VERSION` changing without gateway redeploy)
