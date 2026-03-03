/**
 * DeClaw — OpenClaw plugin entry point.
 *
 * Enables direct P2P communication between OpenClaw instances via Yggdrasil IPv6.
 * Each node gets a globally-routable 200::/8 address derived from its Ed25519 keypair.
 * Messages are signed and verified at the application layer (Ed25519).
 * The Yggdrasil network layer provides additional cryptographic routing guarantees.
 *
 * Usage after install:
 *   openclaw p2p status               — show your Yggdrasil address
 *   openclaw p2p add <ygg-addr>       — add a peer
 *   openclaw p2p peers                — list known peers
 *   openclaw p2p send <ygg-addr> <m>  — send a direct message
 *   openclaw p2p ping <ygg-addr>      — check reachability
 *   /p2p-status                       — show status in chat
 */
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { loadOrCreateIdentity, getActualIpv6 } from "./identity";
import { startYggdrasil, stopYggdrasil, isYggdrasilAvailable, detectExternalYggdrasil, getYggdrasilNetworkInfo } from "./yggdrasil";
import { initDb, listPeers, upsertPeer, removePeer, getPeer, flushDb } from "./peer-db";
import { startPeerServer, stopPeerServer, getInbox, setSelfMeta } from "./peer-server";
import { sendP2PMessage, pingPeer, broadcastLeave } from "./peer-client";
import { bootstrapDiscovery, startDiscoveryLoop, stopDiscoveryLoop, DEFAULT_BOOTSTRAP_PEERS } from "./peer-discovery";
import { upsertDiscoveredPeer } from "./peer-db";
import { buildChannel, wireInboundToGateway, CHANNEL_CONFIG_SCHEMA } from "./channel";
import { Identity, YggdrasilInfo, PluginConfig } from "./types";

const DECLAW_TOOLS = [
  "p2p_add_peer", "p2p_discover", "p2p_list_peers",
  "p2p_send_message", "p2p_status", "yggdrasil_check",
]

function ensureToolsAllowed(config: any): void {
  try {
    const alsoAllow: string[] = config?.tools?.alsoAllow ?? []
    const missing = DECLAW_TOOLS.filter(t => !alsoAllow.includes(t))
    if (missing.length === 0) return

    const merged = [...alsoAllow, ...missing]
    const jsonVal = JSON.stringify(merged)
    execSync(`openclaw config set tools.alsoAllow '${jsonVal}'`, {
      timeout: 5000,
      stdio: "ignore",
    })
    console.log(`[p2p] Auto-enabled ${missing.length} DeClaw tool(s) in tools.alsoAllow`)
  } catch {
    console.warn("[p2p] Could not auto-enable tools — enable manually via: openclaw config set tools.alsoAllow")
  }
}

function ensurePluginAllowed(config: any): void {
  try {
    const allow: string[] | undefined = config?.plugins?.allow
    if (allow === undefined || allow === null) {
      execSync(`openclaw config set plugins.allow '["declaw"]'`, {
        timeout: 5000,
        stdio: "ignore",
      })
      console.log("[p2p] Set plugins.allow to [declaw]")
      return
    }
    if (Array.isArray(allow) && !allow.includes("declaw")) {
      const merged = [...allow, "declaw"]
      execSync(`openclaw config set plugins.allow '${JSON.stringify(merged)}'`, {
        timeout: 5000,
        stdio: "ignore",
      })
      console.log("[p2p] Added declaw to plugins.allow")
    }
  } catch {
    // best effort
  }
}

function ensureChannelConfig(config: any): void {
  try {
    const channelCfg = config?.channels?.declaw
    if (channelCfg && channelCfg.dmPolicy) return
    execSync(`openclaw config set channels.declaw.dmPolicy '"pairing"'`, {
      timeout: 5000,
      stdio: "ignore",
    })
    console.log("[p2p] Set channels.declaw.dmPolicy to pairing")
  } catch {
    // best effort
  }
}

let identity: Identity | null = null;
let yggInfo: YggdrasilInfo | null = null;
let dataDir: string = path.join(os.homedir(), ".openclaw", "declaw");
let peerPort: number = 8099;
let _testMode: boolean = false;
let _startupTimer: ReturnType<typeof setTimeout> | null = null;
let _bootstrapPeers: string[] = [];
let _agentMeta: { name?: string; version?: string } = {};

function tryConnectExternalDaemon(): YggdrasilInfo | null {
  const ext = detectExternalYggdrasil();
  if (!ext || !identity) return null;
  yggInfo = ext;
  identity.yggIpv6 = ext.address;
  console.log(`[p2p] Hot-connected to external daemon: ${ext.address}`);
  return ext;
}

export default function register(api: any) {
  // ── 1. Background service ──────────────────────────────────────────────────
  api.registerService({
    id: "declaw-node",

    start: async () => {
      // Auto-enable DeClaw: plugin allowlist, tools, channel config
      ensurePluginAllowed(api.config)
      ensureToolsAllowed(api.config)
      ensureChannelConfig(api.config)

      const cfg: PluginConfig = api.config?.plugins?.entries?.["declaw"]?.config ?? {};
      dataDir = cfg.data_dir ?? dataDir;
      peerPort = cfg.peer_port ?? peerPort;
      const extraPeers: string[] = cfg.yggdrasil_peers ?? [];
      _bootstrapPeers = cfg.bootstrap_peers ?? [];
      const bootstrapPeers = _bootstrapPeers;
      const discoveryIntervalMs: number = cfg.discovery_interval_ms ?? 10 * 60 * 1000;
      const pluginVersion: string = require("../package.json").version;
      _agentMeta = { name: cfg.agent_name, version: pluginVersion };

      // Resolve test_mode: "auto" (default) detects Yggdrasil availability
      const rawTestMode = cfg.test_mode ?? "auto";
      const testMode = rawTestMode === "auto" ? !isYggdrasilAvailable() : rawTestMode;
      _testMode = testMode;

      if (rawTestMode === "auto") {
        console.log(`[p2p] test_mode=auto — resolved to ${testMode ? "true (yggdrasil not found)" : "false (yggdrasil available)"}`);
      } else {
        console.log(`[p2p] test_mode=${testMode} (explicit config override)`);
      }

      // Load or create Ed25519 identity
      const isFirstRun = !require("fs").existsSync(path.join(dataDir, "identity.json"));
      identity = loadOrCreateIdentity(dataDir);
      initDb(dataDir);

      console.log(`[p2p] Agent ID:  ${identity.agentId}`);
      console.log(`[p2p] CGA IPv6:  ${identity.cgaIpv6}`);

      if (testMode) {
        const actualIpv6 = getActualIpv6();
        if (actualIpv6) {
          identity.yggIpv6 = actualIpv6;
          console.log(`[p2p] Test mode: using actual IPv6 ${actualIpv6}`);
        } else {
          console.log(`[p2p] Ygg (derived): ${identity.yggIpv6}`);
        }
      } else {
        console.log(`[p2p] Ygg (est): ${identity.yggIpv6} (derived, before daemon starts)`);

        // Start Yggdrasil daemon (best-effort)
        if (isYggdrasilAvailable()) {
          yggInfo = await startYggdrasil(dataDir, extraPeers);
          if (yggInfo) {
            identity.yggIpv6 = yggInfo.address;
            console.log(`[p2p] Yggdrasil: ${yggInfo.address}  (subnet: ${yggInfo.subnet})`);
          }
        } else {
          console.warn("[p2p] yggdrasil not installed — run without Yggdrasil (local network only)");
          console.warn("[p2p] Install: https://yggdrasil-network.github.io/installation.html");
        }
      }

      // Start peer HTTP server
      await startPeerServer(peerPort, { testMode });

      // Register self metadata so /peer/announce responses include our name/version
      setSelfMeta({ yggAddr: identity.yggIpv6, publicKey: identity.publicKey, ..._agentMeta });

      // Wire incoming messages to OpenClaw gateway
      wireInboundToGateway(api);

      // First-run welcome message
      if (isFirstRun) {
        const addr = yggInfo?.address ?? identity.yggIpv6;
        const ready = yggInfo !== null;
        const welcomeLines = [
          "Welcome to DeClaw P2P!",
          "",
          ready
            ? `Your P2P address: ${addr}`
            : "Yggdrasil is not set up yet. Run: openclaw p2p setup",
          "",
          "Quick start:",
          "  openclaw p2p status    — show your address",
          "  openclaw p2p discover  — find peers on the network",
          "  openclaw p2p send <addr> <msg>  — send a message",
        ];
        setTimeout(() => {
          try {
            api.gateway?.receiveChannelMessage?.({
              channelId: "declaw",
              accountId: "system",
              text: welcomeLines.join("\n"),
              senderId: "declaw-system",
            });
          } catch { /* best effort */ }
        }, 2000);
      }

      // DHT peer discovery — short delay if using external daemon, longer if just spawned
      const defaultDelay = (yggInfo && yggInfo.pid > 0) ? 30_000 : 5_000;
      const startupDelayMs = cfg.startup_delay_ms ?? defaultDelay;
      console.log(`[p2p] Discovery starts in ${startupDelayMs / 1000}s`);
      _startupTimer = setTimeout(async () => {
        _startupTimer = null;
        console.log(`[p2p:discovery] Starting bootstrap — identity.yggIpv6: ${identity?.yggIpv6}`);
        await bootstrapDiscovery(identity!, peerPort, bootstrapPeers, _agentMeta);
        startDiscoveryLoop(identity!, peerPort, discoveryIntervalMs, bootstrapPeers, _agentMeta);
      }, startupDelayMs);
    },

    stop: async () => {
      if (_startupTimer) {
        clearTimeout(_startupTimer);
        _startupTimer = null;
      }
      stopDiscoveryLoop();
      // Broadcast signed leave tombstone to all known peers before shutting down
      if (identity) {
        await broadcastLeave(identity, listPeers(), peerPort);
      }
      flushDb();
      await stopPeerServer();
      stopYggdrasil();
    },
  });

  // ── 2. OpenClaw Channel ────────────────────────────────────────────────────
  if (identity) {
    api.registerChannel({ plugin: buildChannel(identity, peerPort) });
  } else {
    // Register lazily after service starts — use a proxy channel
    // that reads identity at send-time
    api.registerChannel({
      plugin: {
        id: "declaw",
        meta: {
          id: "declaw",
          label: "DeClaw",
          selectionLabel: "DeClaw (Yggdrasil P2P)",
          docsPath: "/channels/declaw",
          blurb: "Direct encrypted P2P messaging via Yggdrasil IPv6.",
          aliases: ["p2p", "ygg", "ipv6-p2p"],
        },
        capabilities: { chatTypes: ["direct"] },
        configSchema: CHANNEL_CONFIG_SCHEMA,
        config: {
          listAccountIds: () => (identity ? listPeers().map((p) => p.yggAddr) : []),
          resolveAccount: (_: unknown, accountId: string | undefined) => ({
            accountId: accountId ?? "",
            yggAddr: accountId ?? "",
          }),
        },
        outbound: {
          deliveryMode: "direct" as const,
          sendText: async ({ text, account }: { text: string; account: { yggAddr: string } }) => {
            if (!identity) return { ok: false };
            const r = await sendP2PMessage(identity, account.yggAddr, "chat", text, peerPort);
            return { ok: r.ok };
          },
        },
      },
    });
  }

  // ── 3. CLI commands ────────────────────────────────────────────────────────
  api.registerCli(
    ({ program }: { program: any }) => {
      const p2p = program.command("p2p").description("IPv6 P2P node management");

      p2p
        .command("status")
        .description("Show this node's Yggdrasil address and status")
        .action(() => {
          if (!identity) {
            console.log("Plugin not started yet. Try again after gateway restart.");
            return;
          }
          console.log("=== IPv6 P2P Node Status ===");
          if (_agentMeta.name) console.log(`Agent name:     ${_agentMeta.name}`);
          console.log(`Agent ID:       ${identity.agentId}`);
          console.log(`Version:        v${_agentMeta.version}`);
          console.log(`CGA IPv6:       ${identity.cgaIpv6}`);
          console.log(`Yggdrasil:      ${yggInfo?.address ?? identity.yggIpv6 + " (no daemon)"}`);
          console.log(`Peer port:      ${peerPort}`);
          console.log(`Known peers:    ${listPeers().length}`);
          console.log(`Inbox messages: ${getInbox().length}`);
        });

      p2p
        .command("peers")
        .description("List known peers")
        .action(() => {
          const peers = listPeers();
          if (peers.length === 0) {
            console.log("No peers yet. Use 'openclaw p2p add <ygg-addr>' to add one.");
            return;
          }
          console.log("=== Known Peers ===");
          for (const peer of peers) {
            const ago = Math.round((Date.now() - peer.lastSeen) / 1000);
            const label = peer.alias ? ` — ${peer.alias}` : "";
            const ver = peer.version ? ` [v${peer.version}]` : "";
            console.log(`  ${peer.yggAddr}${label}${ver}  last seen ${ago}s ago`);
          }
        });

      p2p
        .command("add <yggAddr>")
        .description("Add a peer by their Yggdrasil address")
        .option("-a, --alias <alias>", "Human-readable alias for this peer")
        .action((yggAddr: string, opts: { alias?: string }) => {
          upsertPeer(yggAddr, opts.alias ?? "");
          console.log(`Peer added: ${yggAddr}${opts.alias ? ` (${opts.alias})` : ""}`);
        });

      p2p
        .command("remove <yggAddr>")
        .description("Remove a peer")
        .action((yggAddr: string) => {
          removePeer(yggAddr);
          console.log(`Peer removed: ${yggAddr}`);
        });

      p2p
        .command("ping <yggAddr>")
        .description("Check if a peer is reachable")
        .action(async (yggAddr: string) => {
          console.log(`Pinging ${yggAddr}...`);
          const ok = await pingPeer(yggAddr, peerPort);
          console.log(ok ? `✓ Reachable` : `✗ Unreachable`);
        });

      p2p
        .command("send <yggAddr> <message>")
        .description("Send a direct message to a peer")
        .action(async (yggAddr: string, message: string) => {
          if (!identity) {
            console.error("Plugin not started. Restart the gateway first.");
            return;
          }
          const result = await sendP2PMessage(identity, yggAddr, "chat", message, 8099);
          if (result.ok) {
            console.log(`✓ Message sent to ${yggAddr}`);
          } else {
            console.error(`✗ Failed: ${result.error}`);
          }
        });

      p2p
        .command("discover")
        .description("Trigger an immediate DHT peer discovery round")
        .action(async () => {
          if (!identity) {
            console.error("Plugin not started. Restart the gateway first.");
            return;
          }
          const cfg: PluginConfig = api.config?.plugins?.entries?.["declaw"]?.config ?? {};
          const bootstrapPeers: string[] = cfg.bootstrap_peers ?? [];
          const all = [...DEFAULT_BOOTSTRAP_PEERS, ...bootstrapPeers];
          console.log(`Discovering peers via ${all.length || "0"} bootstrap node(s)...`);
          const found = await bootstrapDiscovery(identity, peerPort, bootstrapPeers, _agentMeta);
          console.log(`Discovery complete — ${found} new peer(s) found. Total: ${listPeers().length}`);
        });

      p2p
        .command("inbox")
        .description("Show received messages")
        .action(() => {
          const msgs = getInbox();
          if (msgs.length === 0) {
            console.log("No messages received yet.");
            return;
          }
          console.log("=== Inbox ===");
          for (const m of msgs.slice(0, 20)) {
            const time = new Date(m.receivedAt).toLocaleTimeString();
            console.log(`  [${time}] from ${m.fromYgg.slice(0, 20)}...: ${m.content}`);
          }
        });

      p2p
        .command("setup")
        .description("Install and configure Yggdrasil for P2P connectivity")
        .action(() => {
          const scriptPath = require("path").resolve(__dirname, "..", "scripts", "setup-yggdrasil.sh");
          let found = "";
          if (require("fs").existsSync(scriptPath)) found = scriptPath;
          const isRoot = process.getuid?.() === 0;
          if (found) {
            const cmd = isRoot ? `bash "${found}"` : `sudo bash "${found}"`;
            if (!isRoot) console.log("This script requires root privileges. Requesting sudo...");
            try {
              require("child_process").execSync(cmd, { stdio: "inherit" });
            } catch {
              console.error("Setup script failed. Run manually: sudo bash " + found);
            }
          } else {
            console.log("Yggdrasil setup script:");
            console.log("  curl -fsSL https://raw.githubusercontent.com/ReScienceLab/DeClaw/main/scripts/setup-yggdrasil.sh | sudo bash");
          }
        });
    },
    { commands: ["p2p"] }
  );

  // ── 4. Auto-reply slash commands ───────────────────────────────────────────
  api.registerCommand({
    name: "p2p-status",
    description: "Show IPv6 P2P node status",
    handler: () => {
      if (!identity) return { text: "IPv6 P2P: not started yet." };
      const peers = listPeers();
      const addr = yggInfo?.address ?? identity.yggIpv6;
      return {
        text: [
          `**IPv6 P2P Node**`,
          `Address: \`${addr}\``,
          `Peers: ${peers.length} known`,
          `Inbox: ${getInbox().length} messages`,
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "p2p-peers",
    description: "List known P2P peers",
    handler: () => {
      const peers = listPeers();
      if (peers.length === 0) return { text: "No peers yet. Use `openclaw p2p add <addr>`." };
      const lines = peers.map((p) => {
        const label = p.alias ? ` — ${p.alias}` : "";
        const ver = p.version ? ` [v${p.version}]` : "";
        return `• \`${p.yggAddr}\`${label}${ver}`;
      });
      return { text: `**Known Peers**\n${lines.join("\n")}` };
    },
  });

  // ── 5. Agent tools (LLM-callable) ─────────────────────────────────────────
  api.registerTool({
    name: "p2p_add_peer",
    description:
      "Add a remote OpenClaw agent as a P2P peer using their Yggdrasil or ULA IPv6 address. " +
      "Call this when the user provides another agent's IPv6 address and wants to communicate with them.",
    parameters: {
      type: "object",
      properties: {
        ygg_addr: {
          type: "string",
          description: "The peer's Yggdrasil or ULA IPv6 address (e.g. fd77:1234::b or 200:1234::1)",
        },
        alias: {
          type: "string",
          description: "Optional human-readable name for this peer (e.g. 'Alice')",
        },
      },
      required: ["ygg_addr"],
    },
    async execute(_id: string, params: { ygg_addr: string; alias?: string }) {
      upsertPeer(params.ygg_addr, params.alias ?? "");
      const label = params.alias ? ` (${params.alias})` : "";
      return {
        content: [{ type: "text", text: `Peer added: ${params.ygg_addr}${label}` }],
      };
    },
  });

  api.registerTool({
    name: "p2p_send_message",
    description:
      "Send a direct encrypted P2P message to a known peer's agent. " +
      "Use this when the user wants to send a message to another OpenClaw agent by their IPv6 address or alias. " +
      "The message is signed with Ed25519 and delivered over IPv6 without any central server.",
    parameters: {
      type: "object",
      properties: {
        ygg_addr: {
          type: "string",
          description: "The recipient peer's Yggdrasil or ULA IPv6 address",
        },
        message: {
          type: "string",
          description: "The message content to send",
        },
        port: {
          type: "integer",
          description: "The recipient peer's P2P server port (default 8099)",
        },
      },
      required: ["ygg_addr", "message"],
    },
    async execute(_id: string, params: { ygg_addr: string; message: string; port?: number }) {
      if (!identity) {
        return { content: [{ type: "text", text: "Error: P2P service not started yet." }] };
      }
      // Use the peer's port (default 8099) — not peerPort which is the local listening port
      const result = await sendP2PMessage(identity, params.ygg_addr, "chat", params.message, params.port ?? 8099);
      if (result.ok) {
        return {
          content: [{ type: "text", text: `Message delivered to ${params.ygg_addr}` }],
        };
      }
      return {
        content: [{ type: "text", text: `Failed to deliver message: ${result.error}` }],
        isError: true,
      };
    },
  });

  api.registerTool({
    name: "p2p_list_peers",
    description: "List all known P2P peers this agent has communicated with or added manually.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      const peers = listPeers();
      if (peers.length === 0) {
        return { content: [{ type: "text", text: "No peers yet." }] };
      }
      const lines = peers.map((p) => {
        const ago = Math.round((Date.now() - p.lastSeen) / 1000);
        const label = p.alias ? ` — ${p.alias}` : "";
        const ver = p.version ? ` [v${p.version}]` : "";
        return `• ${p.yggAddr}${label}${ver} — last seen ${ago}s ago`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "p2p_status",
    description: "Get this node's own Yggdrasil IPv6 address and P2P service status. " +
      "Share this address with other users so they can reach this agent.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      if (!identity) {
        return { content: [{ type: "text", text: "P2P service not started." }] };
      }
      const addr = yggInfo?.address ?? identity.yggIpv6;
      const peers = listPeers();
      const inbox = getInbox();
      const lines = [
        ...((_agentMeta.name) ? [`Agent name: ${_agentMeta.name}`] : []),
        `This agent's P2P address: ${addr}`,
        `Plugin version: v${_agentMeta.version}`,
        `Known peers: ${peers.length}`,
        `Unread inbox: ${inbox.length} messages`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "p2p_discover",
    description:
      "Trigger an immediate DHT peer discovery round. Announces this node to bootstrap peers " +
      "and absorbs their routing tables. Use when the user wants to find other agents on the network.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      if (!identity) {
        return { content: [{ type: "text", text: "P2P service not started." }] };
      }
      const cfg: PluginConfig = api.config?.plugins?.entries?.["declaw"]?.config ?? {};
      const bootstrapPeers: string[] = cfg.bootstrap_peers ?? [];
      const found = await bootstrapDiscovery(identity, peerPort, bootstrapPeers, _agentMeta);
      const total = listPeers().length;
      return {
        content: [{
          type: "text",
          text: `Discovery complete — ${found} new peer(s) found. Known peers: ${total}`,
        }],
      };
    },
  });

  api.registerTool({
    name: "yggdrasil_check",
    description:
      "Diagnose Yggdrasil installation and daemon status. " +
      "Call this when: the user asks if P2P connectivity is working, asks how to get their address, " +
      "p2p_send_message fails, or the user mentions they haven't installed Yggdrasil. " +
      "Returns whether the binary is installed, whether the daemon is running, the current address " +
      "and whether it is globally routable on the Yggdrasil network.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      const binaryAvailable = isYggdrasilAvailable();

      // Already connected
      if (yggInfo) {
        const netInfo = getYggdrasilNetworkInfo();
        const lines = [
          `Status: Ready`,
          `Your P2P address: ${yggInfo.address}`,
          `Known peers: ${listPeers().length}`,
        ];
        if (netInfo) {
          lines.push(`Network peers: ${netInfo.peerCount} (${netInfo.publicPeers} public)`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // Not connected yet — try to hot-connect to external daemon
      const connected = tryConnectExternalDaemon();
      if (connected) {
        // Auto-trigger discovery in background
        bootstrapDiscovery(identity!, peerPort, _bootstrapPeers, _agentMeta).catch(() => {});
        return {
          content: [{ type: "text", text:
            `Status: Ready (just connected)\n` +
            `Your P2P address: ${connected.address}\n` +
            `Peer discovery started in background.`
          }],
        };
      }

      // No daemon found — guide user
      const action = binaryAvailable
        ? "Yggdrasil is installed but no daemon is running."
        : "Yggdrasil is not installed.";
      return {
        content: [{ type: "text", text:
          `Status: Setup needed\n${action}\n\n` +
          `Fix: Run the automated installer:\n  openclaw p2p setup\n\n` +
          `After setup, call yggdrasil_check again — it will connect automatically.`
        }],
      };
    },
  });
}
