/**
 * Agent Worlds Playground — client
 * Polls the Gateway /worlds endpoint to discover live worlds on the AWN network.
 */

const GATEWAY = window.GATEWAY_URL || "https://gateway.agentworlds.ai";
const POLL_INTERVAL = 15_000;

const $statusDot = document.getElementById("status-dot");
const $statusText = document.getElementById("status-text");
const $networkStats = document.getElementById("network-stats");
const $worldsGrid = document.getElementById("worlds-grid");
const $emptyState = document.getElementById("empty-state");
const $refreshBtn = document.getElementById("refresh-btn");

let gatewayOnline = false;

function setStatus(online, text) {
  gatewayOnline = online;
  $statusDot.className = online ? "connected" : "";
  $statusText.textContent = text;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h ago";
  return Math.floor(diff / 86400_000) + "d ago";
}

function renderWorldCard(world) {
  const isOnline = world.reachable;
  const card = document.createElement("div");
  card.className = "world-card";
  card.innerHTML = `
    <div class="world-card-header">
      <span class="world-name">${escapeHtml(world.name || world.worldId)}</span>
      <span class="world-status ${isOnline ? "online" : "offline"}">${isOnline ? "online" : "unreachable"}</span>
    </div>
    <div class="world-id">world:${escapeHtml(world.worldId)}</div>
    <div class="world-meta">
      <span>Agent: ${world.agentId.slice(0, 12)}...</span>
      <span>Seen: ${timeAgo(world.lastSeen)}</span>
    </div>
    <div class="world-actions">
      ${isOnline ? `<button class="btn-sm btn-primary" onclick="connectToWorld('${escapeHtml(world.worldId)}')">Connect</button>` : ""}
      <button class="btn-sm" onclick="viewWorldInfo('${escapeHtml(world.worldId)}')">Info</button>
    </div>
  `;
  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function fetchWorlds() {
  try {
    const resp = await fetch(`${GATEWAY}/worlds`, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.worlds || [];
  } catch (e) {
    console.warn("Failed to fetch worlds:", e.message);
    return null;
  }
}

async function fetchHealth() {
  try {
    const resp = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch {
    return null;
  }
}

async function refresh() {
  $refreshBtn.disabled = true;
  $refreshBtn.textContent = "...";

  const [health, worlds] = await Promise.all([fetchHealth(), fetchWorlds()]);

  $refreshBtn.disabled = false;
  $refreshBtn.textContent = "Refresh";

  if (health) {
    setStatus(true, "gateway online");
    $networkStats.textContent = `${health.peers} peers / ${health.worlds} worlds`;
  } else {
    setStatus(false, "gateway offline");
    $networkStats.textContent = "";
  }

  if (worlds === null) {
    $worldsGrid.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);">Cannot reach gateway. Is it running on port 8100?</div>';
    $emptyState.classList.add("hidden");
    return;
  }

  $worldsGrid.innerHTML = "";

  if (worlds.length === 0) {
    $emptyState.classList.remove("hidden");
  } else {
    $emptyState.classList.add("hidden");
    worlds.forEach(function(w) {
      $worldsGrid.appendChild(renderWorldCard(w));
    });
  }
}

window.connectToWorld = function(worldId) {
  // For now, open the Gateway WebSocket connection info
  // In the future, this will redirect to the World's own frontend URL
  alert(
    "Connect to world: " + worldId + "\n\n" +
    "WebSocket: " + GATEWAY.replace("http", "ws") + "/ws?world=" + worldId + "\n\n" +
    "Use the AWN OpenClaw plugin:\n" +
    "  p2p_discover() -> join_world(\"" + worldId + "\")"
  );
};

window.viewWorldInfo = async function(worldId) {
  try {
    const resp = await fetch(`${GATEWAY}/worlds/${worldId}`, { signal: AbortSignal.timeout(5_000) });
    const data = await resp.json();
    alert(JSON.stringify(data, null, 2));
  } catch (e) {
    alert("Failed to fetch world info: " + e.message);
  }
};

// Initial load
refresh();

// Poll
setInterval(refresh, POLL_INTERVAL);
