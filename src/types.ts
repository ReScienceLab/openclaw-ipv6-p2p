export interface Identity {
  agentId: string;       // sha256(publicKey)[:16] hex
  publicKey: string;     // base64 Ed25519 public key
  privateKey: string;    // base64 Ed25519 private key
  cgaIpv6: string;       // CGA ULA address (fd00::/8 style)
  yggIpv6: string;       // Derived Yggdrasil address (200::/8 style, before daemon starts)
}

export interface YggdrasilInfo {
  address: string;       // Real Yggdrasil address from daemon (200::/8)
  subnet: string;        // e.g. 300::/64
  pid: number;
}

export interface P2PMessage {
  fromYgg: string;       // sender's Yggdrasil address (must match TCP source IP)
  publicKey: string;     // sender's Ed25519 public key base64 (for TOFU)
  event: "chat" | "ping" | "pong" | "leave" | string;
  content: string;
  timestamp: number;     // unix ms
  signature: string;     // Ed25519 sig over canonical JSON (all fields except signature)
}

export interface PeerRecord {
  yggAddr: string;       // primary key
  publicKey: string;     // verified Ed25519 public key
  alias: string;
  firstSeen: number;
  lastSeen: number;
}

export interface PluginConfig {
  peer_port?: number;
  data_dir?: string;
  yggdrasil_peers?: string[];
  test_mode?: boolean | "auto";
  bootstrap_peers?: string[];
  discovery_interval_ms?: number;
  startup_delay_ms?: number;
}

/** Signed peer-exchange announcement sent to /peer/announce */
export interface PeerAnnouncement {
  fromYgg: string;
  publicKey: string;
  alias?: string;
  timestamp: number;
  signature: string;
  /** peers the sender knows about (shared for gossip) */
  peers: Array<{ yggAddr: string; publicKey: string; alias?: string; lastSeen: number }>;
}

/** Peer record with discovery metadata */
export interface DiscoveredPeerRecord extends PeerRecord {
  discoveredVia?: string;  // yggAddr of the node that told us about this peer
  source: "manual" | "bootstrap" | "gossip";
}
