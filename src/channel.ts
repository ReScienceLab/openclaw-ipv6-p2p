/**
 * OpenClaw channel registration for AWN (Agent World Network) messaging.
 * Account IDs are agentIds.
 */
import { Identity } from "./types"
import { sendP2PMessage, SendOptions } from "./agent-client"
import { listAgents, getAgentIds, getAgent } from "./agent-db"
import { onMessage } from "./agent-server"

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
        description: "Agent IDs allowed to DM (dmPolicy=allowlist)",
      },
    },
  },
  uiHints: {
    dmPolicy: {
      label: "DM Policy",
      help: "open: anyone, pairing: one-time code, allowlist: specific agent IDs only",
    },
    allowFrom: {
      label: "Allow From",
      help: "Agent IDs permitted to send DMs",
    },
  },
}

export function buildChannel(identity: Identity, port: number, getSendOpts?: (id: string) => SendOptions) {
  return {
    id: "awn",
    meta: {
      id: "awn",
      label: "AWN",
      selectionLabel: "AWN (Agent World Network)",
      docsPath: "/channels/awn",
      blurb: "Agent World Network — world-scoped agent communication.",
      aliases: ["p2p"],
    },
    capabilities: { chatTypes: ["direct"] },
    configSchema: CHANNEL_CONFIG_SCHEMA,
    config: {
      listAccountIds: (_cfg: unknown) => getAgentIds(),
      resolveAccount: (_cfg: unknown, accountId: string | undefined) => {
        const id = accountId ?? ""
        const agent = getAgent(id)
        return {
          accountId: id,
          agentId: agent?.agentId ?? id,
          alias: agent?.alias ?? id,
        }
      },
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async ({ text, account }: { text: string; account: { agentId?: string } }) => {
        const agentId = account.agentId ?? ""
        const opts = getSendOpts?.(agentId)
        const result = await sendP2PMessage(identity, agentId, "chat", text, port, 10_000, opts)
        if (!result.ok) {
          console.error(`[awn] Failed to send to ${agentId}: ${result.error}`)
        }
        return { ok: result.ok }
      },
    },
  }
}

export function wireInboundToGateway(api: any): void {
  onMessage((msg) => {
    if (msg.event !== "chat") return
    try {
      api.gateway?.receiveChannelMessage?.({
        channelId: "awn",
        accountId: msg.from,
        text: msg.content,
        senderId: msg.from,
      })
    } catch {
      console.log(`[awn] Message from ${msg.from}: ${msg.content}`)
    }
  })
}
