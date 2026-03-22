# Agent World SDK — Final Three Bug Fixes (BUG-4, BUG-5, BUG-6)

## Summary

Three small bugs remain in `packages/agent-world-sdk/src/`. All are LOW severity and can be fixed in a single batch.

## Priority Item

Fix domain separator mismatch, ledger dead code, and Fastify reply pattern — all in one pass.

## Bugs

### BUG-4 — world.state body signature uses wrong domain separator

**File:** `packages/agent-world-sdk/src/world-server.ts`

In the `broadcastWorldState()` function, find the line that signs the payload body:
```typescript
payload["signature"] = signWithDomainSeparator(
  DOMAIN_SEPARATORS.WORLD_STATE,
```
Change `DOMAIN_SEPARATORS.WORLD_STATE` to `DOMAIN_SEPARATORS.MESSAGE` so it matches what the receiver `/peer/message` handler in peer-protocol.ts verifies with.

### BUG-5 — LEDGER_DOMAIN dead code + LEDGER_SEPARATOR fragile construction

**File:** `packages/agent-world-sdk/src/world-ledger.ts`

Lines 9-10 currently read:
```typescript
const LEDGER_DOMAIN = `AgentWorld-Ledger-${DOMAIN_SEPARATORS.MESSAGE.split("-").slice(-1)[0].replace("\0", "")}`
const LEDGER_SEPARATOR = `AgentWorld-Ledger-${DOMAIN_SEPARATORS.MESSAGE.split("-")[2]}`
```

Replace both lines with:
```typescript
const LEDGER_SEPARATOR = `AgentWorld-Ledger-${PROTOCOL_VERSION}\0`
```

And add `import { PROTOCOL_VERSION } from "./version.js"` to the imports at the top of the file. The import block currently has:
```typescript
import { signWithDomainSeparator, verifyWithDomainSeparator, DOMAIN_SEPARATORS } from "./crypto.js"
```
After the fix, `DOMAIN_SEPARATORS` is no longer needed in this file since `LEDGER_SEPARATOR` no longer derives from it. However, keep it if it's used elsewhere in the file. Check if `DOMAIN_SEPARATORS` is used anywhere else in world-ledger.ts — if not, remove it from the import.

### BUG-6 — Fastify async handler returns undefined after reply.send()

**File:** `packages/agent-world-sdk/src/peer-protocol.ts`

In the `/peer/message` POST handler, find this pattern:
```typescript
if (onMessage) {
  let replied = false;
  await onMessage(
    agentId,
    msg.event as string,
    content,
    (body, statusCode) => {
      replied = true;
      if (statusCode) reply.code(statusCode);
      reply.send(body);
    }
  );
  if (!replied) return { ok: true };
}
```

Add `return reply;` after the `if (!replied)` line so the async handler has an explicit return value when `reply.send()` was already called:
```typescript
  if (!replied) return { ok: true };
  return reply;
```

## Validation

After all fixes:
1. `npm --prefix packages/agent-world-sdk run build` must succeed
2. `npm run build` (root) must succeed
3. `node --test test/*.test.mjs` must pass all existing tests
