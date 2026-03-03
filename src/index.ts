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
import { loadOrCreateIdentity, getActualIpv6 } from "./identity";
import { startYggdrasil, stopYggdrasil, isYggdrasilAvailable, detectExternalYggdrasil } from "./yggdrasil";
import { initDb, listPeers, upsertPeer, removePeer, getPeer } from "./peer-db";
import { startPeerServer, stopPeerServer, getInbox } from "./peer-server";
import { sendP2PMessage, pingPeer } from "./peer-client";
import { bootstrapDiscovery, startDiscoveryLoop, stopDiscoveryLoop, DEFAULT_BOOTSTRAP_PEERS } from "./peer-discovery";
import { upsertDiscoveredPeer } from "./peer-db";
import { buildChannel, wireInboundToGateway } from "./channel";
import { Identity, YggdrasilInfo, PluginConfig } from "./types";

let identity: Identity | null = null;
let yggInfo: YggdrasilInfo | null = null;
let dataDir: string = path.join(os.homedir(), ".openclaw", "declaw");
let peerPort: number = 8099;
let _testMode: boolean = false;
let _startupTimer: ReturnType<typeof setTimeout> | null = null;

export default function register(api: any) {
  // ── 1. Background service ──────────────────────────────────────────────────
  api.registerService({
    id: "declaw-node",

    start: async () => {
      const cfg: PluginConfig = api.config?.plugins?.entries?.["declaw"]?.config ?? {};
      dataDir = cfg.data_dir ?? dataDir;
      peerPort = cfg.peer_port ?? peerPort;
      const extraPeers: string[] = cfg.yggdrasil_peers ?? [];
      const bootstrapPeers: string[] = cfg.bootstrap_peers ?? [];
      const discoveryIntervalMs: number = cfg.discovery_interval_ms ?? 10 * 60 * 1000;

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

      // Wire incoming messages to OpenClaw gateway
      wireInboundToGateway(api);

      // DHT peer discovery — delay startup to let Yggdrasil routes converge
      const startupDelayMs = cfg.startup_delay_ms ?? 30_000;
      _startupTimer = setTimeout(async () => {
        _startupTimer = null;
        console.log(`[p2p:discovery] Starting bootstrap — identity.yggIpv6: ${identity?.yggIpv6}`);
        await bootstrapDiscovery(identity!, peerPort, bootstrapPeers);
        startDiscoveryLoop(identity!, peerPort, discoveryIntervalMs);
      }, startupDelayMs);
    },

    stop: async () => {
      if (_startupTimer) {
        clearTimeout(_startupTimer);
        _startupTimer = null;
      }
      stopDiscoveryLoop();
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
          console.log(`Agent ID:       ${identity.agentId}`);
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
            const alias = peer.alias ? ` (${peer.alias})` : "";
            console.log(`  ${peer.yggAddr}${alias}  last seen ${ago}s ago`);
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
          const result = await sendP2PMessage(identity, yggAddr, "chat", message, peerPort);
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
          const found = await bootstrapDiscovery(identity, peerPort, bootstrapPeers);
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
      const lines = peers.map((p) => `• \`${p.yggAddr}\`${p.alias ? ` — ${p.alias}` : ""}`);
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
        return `• ${p.yggAddr}${p.alias ? ` (${p.alias})` : ""} — last seen ${ago}s ago`;
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
        `This agent's P2P address: ${addr}`,
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
      const found = await bootstrapDiscovery(identity, peerPort, bootstrapPeers);
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
      const daemonRunning = yggInfo !== null;
      const externalDaemon = !daemonRunning ? detectExternalYggdrasil() : null;

      let addressType: string;
      let routable: boolean;
      let address: string;

      if (daemonRunning && yggInfo) {
        addressType = "yggdrasil (globally routable on the Yggdrasil network)";
        routable = true;
        address = yggInfo.address;
      } else if (externalDaemon) {
        addressType = "external yggdrasil daemon detected (not used by plugin — restart gateway)";
        routable = false;
        address = externalDaemon.address;
      } else if (_testMode) {
        addressType = "test_mode (reachable only on the local/Docker network)";
        routable = false;
        address = identity?.yggIpv6 ?? "unknown";
      } else {
        addressType = "derived_only (estimated — NOT routable without Yggdrasil)";
        routable = false;
        address = identity?.yggIpv6 ?? "unknown";
      }

      const lines = [
        `Binary installed : ${binaryAvailable ? "Yes" : "No"}`,
        `Daemon running   : ${daemonRunning ? `Yes (pid ${yggInfo?.pid})` : "No"}`,
        `External daemon  : ${externalDaemon ? `Yes (${externalDaemon.address})` : "No"}`,
        `Plugin address   : ${identity?.yggIpv6 ?? "unknown"}`,
        `Active address   : ${address}`,
        `Address type     : ${addressType}`,
        `Globally routable: ${routable ? "Yes" : "No"}`,
      ];

      if (!binaryAvailable) {
        lines.push(
          "",
          "ACTION REQUIRED: Yggdrasil is not installed.",
          "Without it, your P2P address is not reachable by peers on the internet.",
          "Install instructions: see the yggdrasil skill (references/install.md).",
          "After installing, restart the OpenClaw gateway — the plugin will start Yggdrasil automatically."
        );
      } else if (externalDaemon && !daemonRunning) {
        lines.push(
          "",
          "An external Yggdrasil daemon was found but the plugin is not using it.",
          "Restart the OpenClaw gateway to pick up the external daemon's address."
        );
      } else if (!daemonRunning) {
        lines.push(
          "",
          "Yggdrasil is installed but no daemon is running.",
          "Start one with: sudo yggdrasil -useconffile /etc/yggdrasil.conf &",
          "Or: sudo brew services start yggdrasil",
          "Then restart the OpenClaw gateway."
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
