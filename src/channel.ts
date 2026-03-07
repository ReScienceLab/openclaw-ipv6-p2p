/**
 * OpenClaw channel registration for DeClaw P2P messaging.
 * Registers "declaw" as a messaging channel so OpenClaw users can
 * chat directly with peers via the standard OpenClaw UI.
 */
import { Identity } from "./types";
import { sendP2PMessage, SendOptions } from "./peer-client";
import { listPeers, getPeerAddresses, getPeer, upsertPeer } from "./peer-db";
import { onMessage } from "./peer-server";

/** JSON Schema for channels.declaw — required for OpenClaw Control UI config form */
export const CHANNEL_CONFIG_SCHEMA = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      dmPolicy: {
        type: "string",
        enum: ["open", "pairing", "allowlist"],
        default: "pairing",
      },
      allowFrom: {
        type: "array",
        items: { type: "string" },
        description: "Yggdrasil IPv6 addresses allowed to DM (dmPolicy=allowlist)",
      },
    },
  },
  uiHints: {
    dmPolicy: {
      label: "DM Policy",
      help: "open: anyone, pairing: one-time code, allowlist: specific Yggdrasil addresses only",
    },
    allowFrom: {
      label: "Allow From",
      help: "Yggdrasil IPv6 addresses permitted to send DMs (used when dmPolicy is allowlist)",
    },
  },
}

export function buildChannel(identity: Identity, port: number, getSendOpts?: (addr: string) => SendOptions) {
  return {
    id: "declaw",
    meta: {
      id: "declaw",
      label: "DeClaw",
      selectionLabel: "DeClaw (Yggdrasil P2P)",
      docsPath: "/channels/declaw",
      blurb: "Direct encrypted P2P messaging via Yggdrasil IPv6. No servers, no middlemen.",
      aliases: ["p2p", "ygg", "yggdrasil", "ipv6-p2p"],
    },
    capabilities: { chatTypes: ["direct"] },
    configSchema: CHANNEL_CONFIG_SCHEMA,
    config: {
      /** List all known peer Yggdrasil addresses as "account IDs". */
      listAccountIds: (_cfg: unknown) => getPeerAddresses(),
      /** Resolve an account ID (Ygg address) to an account config object. */
      resolveAccount: (_cfg: unknown, accountId: string | undefined) => {
        const addr = accountId ?? "";
        const peer = listPeers().find((p) => p.yggAddr === addr);
        return { accountId: addr, yggAddr: addr, alias: peer?.alias ?? addr };
      },
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async ({ text, account }: { text: string; account: { yggAddr: string } }) => {
        const opts = getSendOpts?.(account.yggAddr)
        const result = await sendP2PMessage(identity, account.yggAddr, "chat", text, port, 10_000, opts);
        if (!result.ok) {
          console.error(`[declaw] Failed to send to ${account.yggAddr}: ${result.error}`);
        }
        return { ok: result.ok };
      },
    },
  };
}

/**
 * Wire incoming P2P messages to the OpenClaw gateway so they appear
 * in the conversation UI as incoming channel messages.
 */
export function wireInboundToGateway(api: any): void {
  onMessage((msg) => {
    if (msg.event !== "chat") return;
    try {
      api.gateway?.receiveChannelMessage?.({
        channelId: "declaw",
        accountId: msg.fromYgg,
        text: msg.content,
        senderId: msg.fromYgg,
      });
    } catch {
      console.log(`[declaw] Message from ${msg.fromYgg.slice(0, 20)}...: ${msg.content}`);
    }
  });
}
