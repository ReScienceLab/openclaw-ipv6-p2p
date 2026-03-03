/**
 * Standalone P2P test runner — exercises the plugin modules directly,
 * without requiring a full OpenClaw gateway. Runs inside Docker containers.
 *
 * NODE_ROLE=server  — starts peer server, waits for a message, exits 0 on success
 * NODE_ROLE=client  — waits for server, sends one message, exits 0 on success
 */
import { loadOrCreateIdentity, getActualIpv6 } from "./dist/identity.js";
import { initDb } from "./dist/peer-db.js";
import { startPeerServer, getInbox } from "./dist/peer-server.js";
import { sendP2PMessage } from "./dist/peer-client.js";
import { mkdirSync } from "fs";
import { join } from "path";

const ROLE = process.env.NODE_ROLE;
const PEER_ADDR = process.env.PEER_ADDR;
const PORT = parseInt(process.env.P2P_PORT ?? "8099");
const DATA_DIR = join("/tmp", `p2p-${ROLE}`);
const TIMEOUT_MS = 30_000;

if (!ROLE) {
  console.error("NODE_ROLE env var required (server|client)");
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });

const identity = loadOrCreateIdentity(DATA_DIR);
initDb(DATA_DIR);

// Use actual container IPv6 as the P2P address (test mode, no Yggdrasil)
const actualIpv6 = getActualIpv6();
if (actualIpv6) {
  identity.yggIpv6 = actualIpv6;
  console.log(`[${ROLE}] Identity: ${identity.agentId.slice(0, 8)}...`);
  console.log(`[${ROLE}] IPv6:     ${actualIpv6}`);
} else {
  console.warn(`[${ROLE}] WARNING: no non-loopback IPv6 found — messages may fail`);
}

// ── SERVER ──────────────────────────────────────────────────────────────────
if (ROLE === "server") {
  console.log(`[server] Starting peer server on [::]:${PORT} (test mode)...`);
  await startPeerServer(PORT, { testMode: true });
  console.log("[server] Ready. Waiting for a P2P message...");

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const inbox = getInbox();
    if (inbox.length > 0) {
      const msg = inbox[0];
      console.log(`[server] PASS: received ${inbox.length} message(s)`);
      console.log(`[server]   from:    ${msg.fromYgg}`);
      console.log(`[server]   content: "${msg.content}"`);
      console.log(`[server]   event:   ${msg.event}`);
      console.log(`[server]   verified: ${msg.verified}`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`[server] FAIL: no message received within ${TIMEOUT_MS / 1000}s`);
  process.exit(1);
}

// ── CLIENT ──────────────────────────────────────────────────────────────────
if (ROLE === "client") {
  if (!PEER_ADDR) {
    console.error("PEER_ADDR env var required for client role");
    process.exit(1);
  }

  console.log(`[client] Waiting for server at [${PEER_ADDR}]:${PORT}...`);

  // Poll until server is ready
  const deadline = Date.now() + TIMEOUT_MS;
  let serverReady = false;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://[${PEER_ADDR}]:${PORT}/peer/ping`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        serverReady = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  if (!serverReady) {
    console.error(`[client] FAIL: server not reachable after ${TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }

  console.log("[client] Server is ready. Sending message...");
  const result = await sendP2PMessage(
    identity,
    PEER_ADDR,
    "chat",
    "Hello from DeClaw Docker test!",
    PORT
  );

  if (result.ok) {
    console.log("[client] PASS: message sent and accepted by server");
    // Small pause so server has time to log the message before we exit
    await new Promise((r) => setTimeout(r, 1_500));
    process.exit(0);
  } else {
    console.error(`[client] FAIL: ${result.error}`);
    process.exit(1);
  }
}
