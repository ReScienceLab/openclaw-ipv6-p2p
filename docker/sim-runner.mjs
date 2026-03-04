/**
 * DeClaw real-Yggdrasil P2P simulation runner.
 *
 * Both containers join the REAL public Yggdrasil network via public TCP peers,
 * announce themselves to the REAL DeClaw AWS bootstrap nodes, and communicate
 * solely through the Yggdrasil mesh — exactly as real users would.
 *
 * Each container is an autonomous AI agent (via OpenAI gpt-4o).
 * bob initiates, alice replies — 3 rounds of bidirectional conversation.
 *
 * A shared Docker volume (/shared) is used only to exchange Yggdrasil addresses
 * between the two containers (avoids a timing race at bootstrap).
 * All DeClaw traffic flows through the real network with testMode: false.
 *
 * Usage (via docker-compose.sim.yml):
 *   ROLE=server  NODE_NAME=alice  → waits for bob's messages, replies with gpt-4o
 *   ROLE=client  NODE_NAME=bob   → initiates with gpt-4o, replies to alice
 *
 * Container requirements:
 *   --cap-add NET_ADMIN     (Yggdrasil TUN creation)
 *   --device /dev/net/tun   (TUN device access)
 *   /shared volume          (address exchange)
 *   OPENAI_API_KEY env var  (AI auto-reply)
 */
import { loadOrCreateIdentity } from "./dist/identity.js";
import { initDb } from "./dist/peer-db.js";
import { startPeerServer, setSelfMeta, getInbox, stopPeerServer } from "./dist/peer-server.js";
import { sendP2PMessage } from "./dist/peer-client.js";
import { announceToNode, bootstrapDiscovery } from "./dist/peer-discovery.js";
import { execSync, spawn } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync } from "fs";
import { join } from "path";

const ROLE = process.env.ROLE;
const NODE_NAME = process.env.NODE_NAME ?? ROLE;
const PORT = parseInt(process.env.P2P_PORT ?? "8099");
const DATA_DIR = `/tmp/declaw-${NODE_NAME}`;
const SHARED_DIR = "/shared";
const PLUGIN_VERSION = "0.2.2";
const ROUNDS = 3;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

if (!ROLE || (ROLE !== "server" && ROLE !== "client")) {
  console.error("ROLE env var required: server | client");
  process.exit(1);
}

const log = (...args) => console.log(`[${NODE_NAME}]`, ...args);
const die = (msg) => { log("FAIL:", msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── OpenAI API ─────────────────────────────────────────────────────────────

const AGENT_SYSTEM = `You are ${NODE_NAME}, an autonomous AI agent running on the DeClaw \
peer-to-peer network over Yggdrasil IPv6. You are having a direct encrypted conversation \
with another AI agent. Stay in character and keep each reply to 1-2 sentences.`;

async function callLLM(userMessage) {
  if (!OPENAI_API_KEY) {
    return `[no OPENAI_API_KEY] echo: "${userMessage.slice(0, 60)}"`;
  }
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 80,
      messages: [
        { role: "system", content: AGENT_SYSTEM },
        { role: "user",   content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`OpenAI API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

// ── Yggdrasil startup ──────────────────────────────────────────────────────

let yggProc = null;

async function startYggdrasil() {
  const yggDir = join(DATA_DIR, "yggdrasil");
  mkdirSync(yggDir, { recursive: true });

  const confFile = join(yggDir, "yggdrasil.conf");
  const logFile = join(yggDir, "yggdrasil.log");

  let conf;
  try {
    conf = execSync("yggdrasil -genconf", { encoding: "utf-8" });
  } catch {
    die("yggdrasil binary not found — is it installed in the image?");
  }

  conf = conf.replace(/IfName:\s*\S+/, 'IfName: auto');
  if (conf.includes("AdminListen:")) {
    conf = conf.replace(/AdminListen:\s*\S+/, 'AdminListen: "tcp://127.0.0.1:9001"');
  } else {
    conf = conf.replace(/^}(\s*)$/m, '  AdminListen: "tcp://127.0.0.1:9001"\n}$1');
  }

  const yggPeers = [
    "tcp://yggdrasil.mnpnk.com:10002",
    "tcp://ygg.mkg20001.io:80",
    "tcp://46.246.86.205:60002",
  ].map((p) => `    "${p}"`).join(",\n");
  conf = conf.replace(/Peers:\s*\[\s*\]/, `Peers: [\n${yggPeers}\n  ]`);

  writeFileSync(confFile, conf);
  log("Yggdrasil config written — starting daemon...");

  const logFd = openSync(logFile, "w");
  yggProc = spawn("yggdrasil", ["-useconffile", confFile], {
    stdio: ["ignore", logFd, logFd],
    detached: false,
  });
  yggProc.on("exit", (code) => { if (code !== null) log(`Yggdrasil exited (code ${code})`); });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (!existsSync(logFile)) continue;
    const content = readFileSync(logFile, "utf-8");
    if (content.includes("panic:") || content.includes("failed to open /dev/net/tun")) {
      die("Yggdrasil TUN failed — container needs --cap-add NET_ADMIN and --device /dev/net/tun");
    }
    const m = content.match(/Your IPv6 address is (\S+)/);
    if (m) return m[1];
  }
  die("Yggdrasil did not obtain an address within 20s");
}

// ── Cleanup ────────────────────────────────────────────────────────────────

async function cleanup() {
  await stopPeerServer().catch(() => {});
  yggProc?.kill();
}
process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });
process.on("SIGINT",  async () => { await cleanup(); process.exit(0); });

// ── Startup ────────────────────────────────────────────────────────────────

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SHARED_DIR, { recursive: true });

const yggAddr = await startYggdrasil();
log(`Yggdrasil address: ${yggAddr}`);
log(`OpenAI API key:    ${OPENAI_API_KEY ? "configured ✓" : "MISSING — will echo only"}`);

const identity = loadOrCreateIdentity(DATA_DIR);
identity.yggIpv6 = yggAddr;
initDb(DATA_DIR);

log(`Starting DeClaw peer server on [::]:${PORT}...`);
await startPeerServer(PORT, { testMode: false });
setSelfMeta({ yggAddr, publicKey: identity.publicKey, alias: NODE_NAME, version: PLUGIN_VERSION });
log("DeClaw peer server ready");

const addrFile = join(SHARED_DIR, `${NODE_NAME}.addr`);
writeFileSync(addrFile, yggAddr);
log(`Address published → ${addrFile}`);

log("Running bootstrap discovery against real DeClaw network...");
const discovered = await bootstrapDiscovery(identity, PORT, [], {
  name: NODE_NAME,
  version: PLUGIN_VERSION,
});
log(`Bootstrap complete — ${discovered} DeClaw peer(s) on the network`);

// ── ALICE: server role — reply with Claude ─────────────────────────────────
if (ROLE === "server") {
  log(`Waiting for ${ROUNDS} messages from bob (timeout 120s per round)...`);
  let seen = 0;
  let round = 0;

  while (round < ROUNDS) {
    const roundDeadline = Date.now() + 120_000;
    while (getInbox().length <= seen) {
      if (Date.now() > roundDeadline) die(`no message in round ${round + 1} within 120s`);
      await sleep(500);
    }

    const inbox = getInbox();
    const msg = inbox[0]; // newest message (inbox is unshift'd)
    seen = inbox.length;
    round++;

    log(`━━━ Round ${round}/${ROUNDS} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(`  bob:      "${msg.content}"`);
    log(`  verified: ${msg.verified} | from: ${msg.fromYgg}`);

    const reply = await callLLM(msg.content);
    log(`  alice →   "${reply}"`);
    await sendP2PMessage(identity, msg.fromYgg, "chat", reply, PORT);
  }

  log("━━━ PASS — alice: all rounds complete ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await sleep(3000);
  await cleanup();
  process.exit(0);
}

// ── BOB: client role — initiate with Claude ────────────────────────────────
if (ROLE === "client") {
  const aliceFile = join(SHARED_DIR, "alice.addr");
  log("Waiting for alice's address...");
  const addrDeadline = Date.now() + 60_000;
  while (!existsSync(aliceFile)) {
    if (Date.now() > addrDeadline) die("alice.addr not found within 60s");
    await sleep(1000);
  }
  const aliceAddr = readFileSync(aliceFile, "utf-8").trim();
  log(`Alice is at: ${aliceAddr}`);

  log("Announcing to alice (peer exchange)...");
  await announceToNode(identity, aliceAddr, PORT, { name: NODE_NAME, version: PLUGIN_VERSION });

  log("Waiting 15s for Yggdrasil public-mesh routing to converge...");
  await sleep(15000);

  // Generate bob's opening message via Claude
  let nextMessage = await callLLM(
    "Start a brief conversation with Alice about the DeClaw P2P network you are both on. One sentence."
  );

  let seen = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    log(`━━━ Round ${round}/${ROUNDS} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(`  bob →     "${nextMessage}"`);

    const result = await sendP2PMessage(identity, aliceAddr, "chat", nextMessage, PORT);
    if (!result.ok) die(`message failed in round ${round}: ${result.error}`);
    log(`  delivered: ✓`);

    if (round < ROUNDS) {
      // Wait for alice's reply
      const replyDeadline = Date.now() + 60_000;
      while (getInbox().length <= seen) {
        if (Date.now() > replyDeadline) die(`no reply from alice in round ${round}`);
        await sleep(500);
      }
      const aliceMsg = getInbox()[0]; // newest
      seen = getInbox().length;
      log(`  alice →   "${aliceMsg.content}"`);
      nextMessage = await callLLM(aliceMsg.content);
    }
  }

  log("━━━ PASS — bob: all rounds complete ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await sleep(4000); // let alice log final round before we exit
  await cleanup();
  process.exit(0);
}
