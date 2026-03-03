/**
 * Yggdrasil daemon management.
 * Ported from agents/identity.py#start_yggdrasil and yggdrasil-router/entrypoint.sh
 * in the agent-economy-ipv6-mvp project.
 */
import { spawn, ChildProcess, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { YggdrasilInfo } from "./types";

const DEFAULT_BOOTSTRAP_PEERS = [
  "tcp://yggdrasil.mnpnk.com:10002",
  "tcp://ygg.mkg20001.io:80",
  "tcp://46.246.86.205:60002",
];

const WELL_KNOWN_SOCKETS = [
  "/var/run/yggdrasil.sock",
  "/run/yggdrasil.sock",
];

let yggProcess: ChildProcess | null = null;

/**
 * Try to detect an already-running Yggdrasil daemon via its admin socket.
 * Checks well-known socket paths and runs `yggdrasilctl getSelf`.
 */
export function detectExternalYggdrasil(extraSocketPaths: string[] = []): YggdrasilInfo | null {
  const candidates = [...WELL_KNOWN_SOCKETS, ...extraSocketPaths];

  for (const sock of candidates) {
    if (!fs.existsSync(sock)) continue;
    try {
      const endpoint = sock.startsWith("unix://") ? sock : `unix://${sock}`;
      const raw = execSync(`yggdrasilctl -json -endpoint ${endpoint} getSelf`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const data = JSON.parse(raw);
      const address = data.address || data.IPv6Address || data.ipv6_address;
      const subnet = data.subnet || data.IPv6Subnet || data.ipv6_subnet || "";
      if (address) {
        console.log(`[ygg] Detected external Yggdrasil daemon via ${sock}`);
        return { address, subnet, pid: 0 };
      }
    } catch {
      // Socket exists but yggdrasilctl failed — try next
    }
  }
  return null;
}

/** Check if the yggdrasil binary is available on PATH. */
export function isYggdrasilAvailable(): boolean {
  try {
    execSync("yggdrasil -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate Yggdrasil config file with the given bootstrap peers.
 * Patches IfName to "auto" (creates TUN, making 200::/8 routable),
 * injects AdminListen socket, and sets bootstrap peers.
 */
function generateConfig(confFile: string, sockFile: string, extraPeers: string[]): void {
  const raw = execSync("yggdrasil -genconf", { encoding: "utf-8" });
  let conf = raw;

  // Inject AdminListen if missing (Yggdrasil 0.5.x omits it by default)
  if (!conf.includes("AdminListen:")) {
    conf = conf.trimEnd();
    if (conf.endsWith("}")) {
      conf = conf.slice(0, -1).trimEnd() + `\n  AdminListen: "unix://${sockFile}"\n}\n`;
    }
  } else {
    conf = conf.replace(/AdminListen:.*/, `AdminListen: "unix://${sockFile}"`);
  }

  // Enable TUN interface so 200::/8 addresses are routable
  conf = conf.replace(/IfName:.*/, "IfName: auto");

  // Set bootstrap peers
  const allPeers = [...DEFAULT_BOOTSTRAP_PEERS, ...extraPeers];
  const peerStr = allPeers.map((p) => `    "${p}"`).join("\n");
  conf = conf.replace(/Peers:\s*\[\s*\]/, `Peers: [\n${peerStr}\n  ]`);

  fs.writeFileSync(confFile, conf);
}

/**
 * Start the Yggdrasil daemon and wait for it to obtain an address.
 * Returns null if yggdrasil binary is not found or startup fails.
 */
export async function startYggdrasil(
  dataDir: string,
  extraPeers: string[] = []
): Promise<YggdrasilInfo | null> {
  if (!isYggdrasilAvailable()) {
    console.warn("[ygg] yggdrasil binary not found — P2P via Yggdrasil disabled");
    return null;
  }

  // 1. Try to reuse an already-running system Yggdrasil
  const pluginSock = path.join(dataDir, "yggdrasil", "yggdrasil.sock");
  const external = detectExternalYggdrasil([pluginSock]);
  if (external) {
    console.log(`[ygg] Reusing external daemon — address: ${external.address}`);
    return external;
  }

  // 2. No external daemon found — spawn our own
  console.log("[ygg] No external Yggdrasil daemon detected — spawning managed instance");
  const yggDir = path.join(dataDir, "yggdrasil");
  fs.mkdirSync(yggDir, { recursive: true });

  const confFile = path.join(yggDir, "yggdrasil.conf");
  const sockFile = pluginSock;
  const logFile = path.join(yggDir, "yggdrasil.log");

  if (!fs.existsSync(confFile)) {
    generateConfig(confFile, sockFile, extraPeers);
  } else {
    let conf = fs.readFileSync(confFile, "utf-8");
    const updated = conf.replace(/IfName:.*/, "IfName: auto");
    if (updated !== conf) {
      fs.writeFileSync(confFile, updated);
    }
  }

  const logStream = fs.openSync(logFile, "w");
  yggProcess = spawn("yggdrasil", ["-useconffile", confFile], {
    stdio: ["ignore", logStream, logStream],
    detached: false,
  });

  // Wait up to 15s for address to appear in log
  const info = await waitForAddress(logFile, 15);
  if (!info) {
    yggProcess.kill();
    yggProcess = null;
    return null;
  }

  // Verify the spawned process is still alive (TUN creation may fail without root)
  await sleep(500);
  if (yggProcess.exitCode !== null) {
    const logContent = fs.readFileSync(logFile, "utf-8");
    const panicMatch = logContent.match(/panic: (.+)/);
    console.warn(`[ygg] Spawned Yggdrasil exited: ${panicMatch?.[1] ?? "unknown reason"}`);
    console.warn("[ygg] TUN creation requires root. Use a system-level Yggdrasil daemon instead.");
    yggProcess = null;
    return null;
  }

  console.log(`[ygg] Started — address: ${info.address}  pid: ${info.pid}`);
  return info;
}

async function waitForAddress(logFile: string, timeoutSec: number): Promise<YggdrasilInfo | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (!fs.existsSync(logFile)) continue;
    const content = fs.readFileSync(logFile, "utf-8");
    const mAddr = content.match(/Your IPv6 address is (\S+)/);
    const mSub = content.match(/Your IPv6 subnet is (\S+)/);
    if (mAddr) {
      return {
        address: mAddr[1],
        subnet: mSub ? mSub[1] : "",
        pid: yggProcess?.pid ?? 0,
      };
    }
  }
  return null;
}

export function stopYggdrasil(): void {
  if (yggProcess) {
    yggProcess.kill();
    yggProcess = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
