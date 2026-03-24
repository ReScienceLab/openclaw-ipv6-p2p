use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::agent_db::{AgentDb, AgentRecord, Endpoint};
use crate::crypto::{
    build_signed_p2p_message, sign_http_request, sign_http_response, verify_http_response,
};
use crate::identity::{self, Identity};

const DEFAULT_IPC_PORT: u16 = 8199;
const PORT_FILE: &str = "daemon.port";
const PID_FILE: &str = "daemon.pid";

#[derive(Clone, Serialize, Deserialize)]
pub struct JoinedWorld {
    #[serde(rename = "worldId")]
    pub world_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    pub name: String,
    pub address: String,
    pub port: u16,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "joinedAt")]
    pub joined_at: u64,
}

#[derive(Clone)]
pub struct DaemonState {
    pub identity: Identity,
    pub agent_db: Arc<Mutex<AgentDb>>,
    pub joined_worlds: Arc<Mutex<HashMap<String, JoinedWorld>>>,
    pub received_messages: Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>,
    pub data_dir: PathBuf,
    pub gateway_url: String,
    pub listen_port: u16,
    /// Address to advertise in world.join endpoint payload (e.g. a public IP or VPN address).
    pub advertise_address: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct StatusResponse {
    pub agent_id: String,
    pub pub_b64: String,
    pub version: String,
    pub listen_port: u16,
    pub gateway_url: String,
    pub known_agents: usize,
    pub data_dir: String,
}

#[derive(Serialize, Deserialize)]
pub struct AgentsResponse {
    pub agents: Vec<AgentRecord>,
}

#[derive(Serialize, Deserialize)]
pub struct WorldsResponse {
    pub worlds: Vec<WorldSummary>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WorldSummary {
    #[serde(rename = "worldId")]
    pub world_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub name: String,
    pub endpoints: Vec<Endpoint>,
    pub reachable: bool,
    #[serde(rename = "lastSeen")]
    pub last_seen: u64,
}

#[derive(Serialize, Deserialize)]
pub struct WorldInfoResponse {
    #[serde(rename = "worldId")]
    pub world_id: String,
    pub name: String,
    pub endpoints: Vec<Endpoint>,
    pub reachable: bool,
    pub manifest: Option<WorldManifest>,
}

#[derive(Serialize, Deserialize)]
pub struct WorldManifest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<std::collections::HashMap<String, ActionSchema>>,
}

#[derive(Serialize, Deserialize)]
pub struct ActionSchema {
    pub desc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<std::collections::HashMap<String, ActionParam>>,
}

#[derive(Serialize, Deserialize)]
pub struct ActionParam {
    #[serde(rename = "type")]
    pub param_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
}

#[derive(Deserialize)]
pub struct AgentsQuery {
    pub capability: Option<String>,
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Serialize, Deserialize)]
pub struct OkResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct JoinedWorldsResponse {
    pub worlds: Vec<JoinedWorld>,
}

#[derive(Serialize, Deserialize)]
pub struct PingResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct SendMessageBody {
    pub agent_id: String,
    pub message: String,
}

pub struct DaemonHandle {
    shutdown_tx: oneshot::Sender<()>,
    pub addr: SocketAddr,
    pub peer_addr: SocketAddr,
}

impl DaemonHandle {
    pub fn shutdown(self) {
        let _ = self.shutdown_tx.send(());
    }
}

const MEMBER_REFRESH_SECS: u64 = 30;

pub async fn start_daemon(
    data_dir: PathBuf,
    gateway_url: String,
    listen_port: u16,
    ipc_port: u16,
    advertise_address: Option<String>,
) -> Result<DaemonHandle, DaemonError> {
    let identity = identity::load_or_create_identity(&data_dir, "identity")
        .map_err(|e| DaemonError::Identity(e.to_string()))?;
    let agent_db = AgentDb::open(&data_dir);

    // Bind peer listener first so we know the actual port before building state.
    let peer_bind = SocketAddr::from(([0, 0, 0, 0], listen_port));
    let peer_listener = tokio::net::TcpListener::bind(peer_bind)
        .await
        .map_err(|e| DaemonError::Bind(format!("peer port {listen_port}: {e}")))?;
    let bound_peer_addr = peer_listener.local_addr().unwrap();

    let state = DaemonState {
        identity,
        agent_db: Arc::new(Mutex::new(agent_db)),
        joined_worlds: Arc::new(Mutex::new(HashMap::new())),
        received_messages: Arc::new(Mutex::new(std::collections::VecDeque::with_capacity(100))),
        data_dir,
        gateway_url,
        listen_port: bound_peer_addr.port(), // actual bound port (may differ when 0 requested)
        advertise_address,
    };

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (ipc_shutdown_tx, ipc_shutdown_rx) = oneshot::channel::<()>();

    // ── IPC server (loopback) ───────────────────────────────────────────────
    let ipc_app = Router::new()
        .route("/ipc/status", get(handle_status))
        .route("/ipc/agents", get(handle_agents))
        .route("/ipc/worlds", get(handle_worlds))
        .route("/ipc/world/{world_id}", get(handle_world_info))
        .route("/ipc/ping", get(handle_ping))
        .route("/ipc/joined", get(handle_joined_worlds))
        .route("/ipc/join/{world_id}", post(handle_join_world))
        .route("/ipc/leave/{world_id}", post(handle_leave_world))
        .route("/ipc/peer/ping/{agent_id}", get(handle_ping_agent))
        .route("/ipc/send", post(handle_send_message))
        .route("/ipc/messages", get(handle_messages))
        .route(
            "/ipc/shutdown",
            post({
                let tx = Arc::new(std::sync::Mutex::new(Some(ipc_shutdown_tx)));
                move || {
                    let tx = tx.clone();
                    async move {
                        if let Some(tx) = tx.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        Json(OkResponse {
                            ok: true,
                            message: Some("shutting down".to_string()),
                        })
                    }
                }
            }),
        )
        .with_state(state.clone());

    let ipc_addr = SocketAddr::from(([127, 0, 0, 1], ipc_port));
    let ipc_listener = tokio::net::TcpListener::bind(ipc_addr)
        .await
        .map_err(|e| DaemonError::Bind(e.to_string()))?;
    let bound_ipc_addr = ipc_listener.local_addr().unwrap();

    // ── Peer server (all interfaces) ────────────────────────────────────────
    let peer_app = Router::new()
        .route("/peer/ping", get(handle_peer_ping))
        .route("/peer/message", post(handle_peer_message))
        .with_state(state.clone());

    // ── Background: member refresh every 30 s ───────────────────────────────
    let refresh_state = state.clone();
    tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_secs(MEMBER_REFRESH_SECS));
        ticker.tick().await; // skip first immediate tick
        loop {
            ticker.tick().await;
            do_refresh_world_members(&refresh_state).await;
        }
    });

    tokio::spawn(async move {
        axum::serve(ipc_listener, ipc_app)
            .with_graceful_shutdown(async {
                tokio::select! {
                    _ = shutdown_rx => {}
                    _ = ipc_shutdown_rx => {}
                }
            })
            .await
            .ok();
    });

    tokio::spawn(async move {
        axum::serve(peer_listener, peer_app).await.ok();
    });

    Ok(DaemonHandle {
        shutdown_tx,
        addr: bound_ipc_addr,
        peer_addr: bound_peer_addr,
    })
}

async fn handle_status(State(state): State<DaemonState>) -> Json<StatusResponse> {
    let agent_count = state.agent_db.lock().unwrap().size();
    Json(StatusResponse {
        agent_id: state.identity.agent_id.clone(),
        pub_b64: state.identity.pub_b64.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        listen_port: state.listen_port,
        gateway_url: state.gateway_url.clone(),
        known_agents: agent_count,
        data_dir: state.data_dir.to_string_lossy().to_string(),
    })
}

async fn handle_agents(
    State(state): State<DaemonState>,
    axum::extract::Query(query): axum::extract::Query<AgentsQuery>,
) -> Json<AgentsResponse> {
    let db = state.agent_db.lock().unwrap();
    let agents = if let Some(cap) = &query.capability {
        db.find_by_capability(cap).into_iter().cloned().collect()
    } else {
        db.list().into_iter().cloned().collect()
    };
    Json(AgentsResponse { agents })
}

async fn handle_worlds(State(state): State<DaemonState>) -> Json<WorldsResponse> {
    // Fetch from gateway
    let mut worlds = Vec::new();
    let url = format!("{}/worlds", state.gateway_url.trim_end_matches('/'));
    if let Ok(resp) = reqwest::get(&url).await {
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            if let Some(arr) = data.get("worlds").and_then(|w| w.as_array()) {
                for w in arr {
                    let world_id = w.get("worldId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let agent_id = w.get("agentId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = w.get("name").and_then(|v| v.as_str()).unwrap_or(&world_id).to_string();
                    let last_seen = w.get("lastSeen").and_then(|v| v.as_u64()).unwrap_or(0);
                    let endpoints: Vec<Endpoint> = w
                        .get("endpoints")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let reachable = !endpoints.is_empty();
                    worlds.push(WorldSummary {
                        world_id,
                        agent_id,
                        name,
                        endpoints,
                        reachable,
                        last_seen,
                    });
                }
            }
        }
    }

    // Merge with local cache
    {
        let db = state.agent_db.lock().unwrap();
        let local_worlds = db.find_by_capability("world:");
        for lw in local_worlds {
            if !worlds.iter().any(|w| w.agent_id == lw.agent_id) {
                let cap = lw.capabilities.iter().find(|c| c.starts_with("world:")).cloned().unwrap_or_default();
                let world_id = cap.strip_prefix("world:").unwrap_or("").to_string();
                worlds.push(WorldSummary {
                    world_id,
                    agent_id: lw.agent_id.clone(),
                    name: if lw.alias.is_empty() { cap.clone() } else { lw.alias.clone() },
                    endpoints: lw.endpoints.clone(),
                    reachable: !lw.endpoints.is_empty(),
                    last_seen: lw.last_seen,
                });
            }
        }
    }

    Json(WorldsResponse { worlds })
}

async fn handle_world_info(
    State(state): State<DaemonState>,
    Path(world_id): Path<String>,
) -> Result<Json<WorldInfoResponse>, StatusCode> {
    // First try to get from gateway
    let url = format!("{}/worlds", state.gateway_url.trim_end_matches('/'));
    let mut world_summary: Option<WorldSummary> = None;

    if let Ok(resp) = reqwest::get(&url).await {
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            if let Some(arr) = data.get("worlds").and_then(|w| w.as_array()) {
                for w in arr {
                    let wid = w.get("worldId").and_then(|v| v.as_str()).unwrap_or("");
                    if wid == world_id {
                        let agent_id = w.get("agentId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = w.get("slug").and_then(|v| v.as_str()).unwrap_or(&world_id).to_string();
                        let last_seen = w.get("lastSeen").and_then(|v| v.as_u64()).unwrap_or(0);
                        let endpoints: Vec<Endpoint> = w
                            .get("endpoints")
                            .and_then(|v| serde_json::from_value(v.clone()).ok())
                            .unwrap_or_default();
                        let reachable = !endpoints.is_empty();
                        world_summary = Some(WorldSummary {
                            world_id: wid.to_string(),
                            agent_id,
                            name,
                            endpoints,
                            reachable,
                            last_seen,
                        });
                        break;
                    }
                }
            }
        }
    }

    // Fallback to local cache
    if world_summary.is_none() {
        let db = state.agent_db.lock().unwrap();
        let local_worlds = db.find_by_capability("world:");

        // Try to find by protocol ID (agent_id) or by slug (from capability)
        for lw in local_worlds {
            let cap = lw.capabilities.iter().find(|c| c.starts_with("world:")).cloned().unwrap_or_default();
            let slug = cap.strip_prefix("world:").unwrap_or("");

            // Match by protocol ID or slug
            if lw.agent_id == world_id || slug == world_id {
                world_summary = Some(WorldSummary {
                    world_id: slug.to_string(),
                    agent_id: lw.agent_id.clone(),
                    name: if lw.alias.is_empty() { slug.to_string() } else { lw.alias.clone() },
                    endpoints: lw.endpoints.clone(),
                    reachable: !lw.endpoints.is_empty(),
                    last_seen: lw.last_seen,
                });
                break;
            }
        }
    }

    let world = world_summary.ok_or(StatusCode::NOT_FOUND)?;

    // Try to fetch manifest from world endpoint
    let mut manifest: Option<WorldManifest> = None;
    if !world.endpoints.is_empty() {
        let sorted = {
            let mut eps = world.endpoints.clone();
            eps.sort_by_key(|e| e.priority);
            eps
        };

        for ep in sorted {
            let url = if ep.address.contains(':') && !ep.address.contains('.') {
                format!("http://[{}]:{}/world/manifest", ep.address, ep.port)
            } else {
                format!("http://{}:{}/world/manifest", ep.address, ep.port)
            };

            if let Ok(resp) = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                reqwest::get(&url)
            ).await {
                if let Ok(resp) = resp {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        if let Some(m) = data.get("manifest") {
                            manifest = serde_json::from_value(m.clone()).ok();
                            break;
                        }
                    }
                }
            }
        }
    }

    Ok(Json(WorldInfoResponse {
        world_id: world.world_id,
        name: world.name,
        endpoints: world.endpoints,
        reachable: world.reachable,
        manifest,
    }))
}

async fn handle_ping() -> Json<OkResponse> {
    Json(OkResponse {
        ok: true,
        message: Some("daemon alive".to_string()),
    })
}

// ── Peer server handlers ────────────────────────────────────────────────────

async fn handle_peer_ping(State(state): State<DaemonState>) -> axum::response::Response {
    let body = serde_json::json!({
        "ok": true,
        "agentId": state.identity.agent_id,
        "publicKey": state.identity.pub_b64,
    })
    .to_string();
    let h = sign_http_response(&state.identity, 200, &body);
    axum::response::Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .header("X-AgentWorld-Version", h.version)
        .header("X-AgentWorld-From", h.from_agent)
        .header("X-AgentWorld-KeyId", h.key_id)
        .header("X-AgentWorld-Timestamp", h.timestamp)
        .header("Content-Digest", h.content_digest)
        .header("X-AgentWorld-Signature", h.signature)
        .body(axum::body::Body::from(body))
        .unwrap()
}

async fn handle_peer_message(
    State(state): State<DaemonState>,
    body: String,
) -> axum::response::Response {
    if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&body) {
        if msg.get("from").is_some() && msg.get("event").is_some() && msg.get("signature").is_some() {
            let mut msgs = state.received_messages.lock().unwrap();
            if msgs.len() >= 100 {
                msgs.pop_front();
            }
            msgs.push_back(msg);
        }
    }
    let resp_body = serde_json::json!({"ok": true}).to_string();
    let h = sign_http_response(&state.identity, 200, &resp_body);
    axum::response::Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .header("X-AgentWorld-Version", h.version)
        .header("X-AgentWorld-From", h.from_agent)
        .header("X-AgentWorld-KeyId", h.key_id)
        .header("X-AgentWorld-Timestamp", h.timestamp)
        .header("Content-Digest", h.content_digest)
        .header("X-AgentWorld-Signature", h.signature)
        .body(axum::body::Body::from(resp_body))
        .unwrap()
}

// ── IPC: received messages ──────────────────────────────────────────────────

async fn handle_messages(State(state): State<DaemonState>) -> Json<serde_json::Value> {
    let msgs: Vec<_> = state.received_messages.lock().unwrap().iter().cloned().collect();
    Json(serde_json::json!({ "messages": msgs }))
}

// ── Background: member refresh ──────────────────────────────────────────────

async fn do_refresh_world_members(state: &DaemonState) {
    let worlds: Vec<JoinedWorld> =
        state.joined_worlds.lock().unwrap().values().cloned().collect();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    for world in worlds {
        let is_ipv6 = world.address.contains(':') && !world.address.contains('.');
        let host = if is_ipv6 {
            format!("[{}]:{}", world.address, world.port)
        } else {
            format!("{}:{}", world.address, world.port)
        };
        let url = format!("http://{}/world/members", host);
        let hdrs = sign_http_request(&state.identity, "GET", &host, "/world/members", "");

        let result = client
            .get(&url)
            .header("X-AgentWorld-Version", &hdrs.version)
            .header("X-AgentWorld-From", &hdrs.from_agent)
            .header("X-AgentWorld-KeyId", &hdrs.key_id)
            .header("X-AgentWorld-Timestamp", &hdrs.timestamp)
            .header("Content-Digest", &hdrs.content_digest)
            .header("X-AgentWorld-Signature", &hdrs.signature)
            .send()
            .await;

        match result {
            Ok(r) if r.status().as_u16() == 403 || r.status().as_u16() == 404 => {
                state.joined_worlds.lock().unwrap().remove(&world.world_id);
            }
            Ok(r) if r.status().is_success() => {
                if let Ok(data) = r.json::<serde_json::Value>().await {
                    if let Some(members) = data.get("members").and_then(|m| m.as_array()) {
                        let mut db = state.agent_db.lock().unwrap();
                        for member in members {
                            let Some(aid) = member.get("agentId").and_then(|v| v.as_str()) else {
                                continue;
                            };
                            if aid == state.identity.agent_id {
                                continue;
                            }
                            let alias = member.get("alias").and_then(|v| v.as_str());
                            let endpoints: Vec<Endpoint> = member
                                .get("endpoints")
                                .and_then(|v| serde_json::from_value(v.clone()).ok())
                                .unwrap_or_default();
                            db.upsert(aid, "", alias, Some(endpoints), None, Some("gossip"), None);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

// ── IPC: joined worlds ──────────────────────────────────────────────────────

async fn handle_joined_worlds(State(state): State<DaemonState>) -> Json<JoinedWorldsResponse> {
    let worlds = state
        .joined_worlds
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect();
    Json(JoinedWorldsResponse { worlds })
}

async fn handle_join_world(
    State(state): State<DaemonState>,
    Path(world_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();

    // Resolve world: try direct worldId first, then search by slug
    let (address, port, public_key, resolved_world_id, slug) =
        resolve_world(&client, &state.gateway_url, &world_id)
            .await
            .map_err(|_| StatusCode::NOT_FOUND)?;

    // Build join P2P message — include our peer endpoint so the world server
    // can reach us for broadcasts and member refreshes.
    let advertise_addr = state
        .advertise_address
        .as_deref()
        .unwrap_or("127.0.0.1")
        .to_string();
    let content = serde_json::json!({
        "endpoints": [{
            "transport": "tcp",
            "address": advertise_addr,
            "port": state.listen_port,
            "priority": 1,
            "ttl": 3600
        }],
        "alias": ""
    })
    .to_string();
    let msg = build_signed_p2p_message(&state.identity, "world.join", &content);

    // Send to world server
    let is_ipv6 = address.contains(':') && !address.contains('.');
    let host = if is_ipv6 {
        format!("[{}]:{}", address, port)
    } else {
        format!("{}:{}", address, port)
    };
    let url = format!("http://{}/peer/message", host);
    let body = msg.to_string();
    let headers = sign_http_request(&state.identity, "POST", &host, "/peer/message", &body);

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-AgentWorld-Version", &headers.version)
        .header("X-AgentWorld-From", &headers.from_agent)
        .header("X-AgentWorld-KeyId", &headers.key_id)
        .header("X-AgentWorld-Timestamp", &headers.timestamp)
        .header("Content-Digest", &headers.content_digest)
        .header("X-AgentWorld-Signature", &headers.signature)
        .body(body)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !resp.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }

    let resp_data: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));

    // Extract manifest name for display
    let name = resp_data
        .get("manifest")
        .and_then(|m| m.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or(slug.as_deref().unwrap_or(&resolved_world_id))
        .to_string();

    // Store joined world
    let joined = JoinedWorld {
        world_id: resolved_world_id.clone(),
        slug: slug.clone(),
        name: name.clone(),
        address: address.clone(),
        port,
        public_key: public_key.clone(),
        agent_id: public_key_to_agent_id(&public_key),
        joined_at: now_ms(),
    };
    state
        .joined_worlds
        .lock()
        .unwrap()
        .insert(resolved_world_id.clone(), joined);

    // Store co-members in agent_db
    if let Some(members) = resp_data.get("members").and_then(|m| m.as_array()) {
        let mut db = state.agent_db.lock().unwrap();
        for member in members {
            if let Some(agent_id) = member.get("agentId").and_then(|v| v.as_str()) {
                if agent_id == state.identity.agent_id {
                    continue;
                }
                let alias = member
                    .get("alias")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let endpoints: Vec<Endpoint> = member
                    .get("endpoints")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                db.upsert(
                    agent_id,
                    "",
                    alias.as_deref(),
                    Some(endpoints),
                    None,
                    Some("gossip"),
                    None,
                );
            }
        }
    }

    let member_count = resp_data
        .get("members")
        .and_then(|m| m.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    Ok(Json(serde_json::json!({
        "ok": true,
        "worldId": resolved_world_id,
        "slug": slug,
        "name": name,
        "members": member_count,
        "manifest": resp_data.get("manifest"),
    })))
}

async fn handle_leave_world(
    State(state): State<DaemonState>,
    Path(world_id): Path<String>,
) -> Result<Json<OkResponse>, StatusCode> {
    let joined = state
        .joined_worlds
        .lock()
        .unwrap()
        .get(&world_id)
        .or_else(|| {
            // Also try by slug — not directly possible with .get(), handled below
            None
        })
        .cloned();

    // Also search by slug
    let joined = if joined.is_none() {
        state
            .joined_worlds
            .lock()
            .unwrap()
            .values()
            .find(|w| w.slug.as_deref() == Some(&world_id))
            .cloned()
    } else {
        joined
    };

    let info = joined.ok_or(StatusCode::NOT_FOUND)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();

    let msg = build_signed_p2p_message(&state.identity, "world.leave", "");
    let is_ipv6 = info.address.contains(':') && !info.address.contains('.');
    let host = if is_ipv6 {
        format!("[{}]:{}", info.address, info.port)
    } else {
        format!("{}:{}", info.address, info.port)
    };
    let url = format!("http://{}/peer/message", host);
    let body = msg.to_string();
    let headers = sign_http_request(&state.identity, "POST", &host, "/peer/message", &body);

    // Best-effort — don't fail if server is unreachable
    let _ = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-AgentWorld-Version", &headers.version)
        .header("X-AgentWorld-From", &headers.from_agent)
        .header("X-AgentWorld-KeyId", &headers.key_id)
        .header("X-AgentWorld-Timestamp", &headers.timestamp)
        .header("Content-Digest", &headers.content_digest)
        .header("X-AgentWorld-Signature", &headers.signature)
        .body(body)
        .send()
        .await;

    state
        .joined_worlds
        .lock()
        .unwrap()
        .remove(&info.world_id);

    Ok(Json(OkResponse {
        ok: true,
        message: Some(format!("Left world {}", info.world_id)),
    }))
}

async fn handle_ping_agent(
    State(state): State<DaemonState>,
    Path(agent_id): Path<String>,
) -> Json<PingResponse> {
    let endpoints = {
        let db = state.agent_db.lock().unwrap();
        db.get(&agent_id)
            .map(|r| r.endpoints.clone())
            .unwrap_or_default()
    };

    if endpoints.is_empty() {
        return Json(PingResponse {
            ok: false,
            latency_ms: None,
            error: Some("No known endpoints for agent".to_string()),
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();

    let mut sorted = endpoints;
    sorted.sort_by_key(|e| e.priority);

    for ep in &sorted {
        if ep.transport != "tcp" && ep.transport != "http" {
            continue;
        }
        let is_ipv6 = ep.address.contains(':') && !ep.address.contains('.');
        let host = if is_ipv6 {
            format!("[{}]:{}", ep.address, ep.port)
        } else {
            format!("{}:{}", ep.address, ep.port)
        };
        let url = format!("http://{}/peer/ping", host);
        let start = std::time::Instant::now();
        let Ok(resp) = client.get(&url).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let latency = start.elapsed().as_millis() as u64;

        // Verify signed response when we have the agent's public key.
        let pub_key = {
            let db = state.agent_db.lock().unwrap();
            db.get(&agent_id).map(|r| r.public_key.clone()).unwrap_or_default()
        };
        if !pub_key.is_empty() {
            // Extract headers before consuming the response body
            let hdr = |name: &str| -> String {
                resp.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string()
            };
            let ver = hdr("x-agentworld-version");
            let sig = hdr("x-agentworld-signature");
            let from = hdr("x-agentworld-from");
            let kid  = hdr("x-agentworld-keyid");
            let ts   = hdr("x-agentworld-timestamp");
            let cd   = hdr("content-digest");
            if !ver.is_empty() && !sig.is_empty() {
                if let Ok(body_text) = resp.text().await {
                    if !verify_http_response(&ver, &from, &kid, &ts, &cd, &sig, 200, &body_text, &pub_key) {
                        continue;
                    }
                }
            }
        }

        return Json(PingResponse { ok: true, latency_ms: Some(latency), error: None });
    }

    Json(PingResponse {
        ok: false,
        latency_ms: None,
        error: Some("Unreachable".to_string()),
    })
}

async fn handle_send_message(
    State(state): State<DaemonState>,
    Json(body): Json<SendMessageBody>,
) -> Result<Json<OkResponse>, StatusCode> {
    let endpoints = {
        let db = state.agent_db.lock().unwrap();
        db.get(&body.agent_id)
            .map(|r| r.endpoints.clone())
            .unwrap_or_default()
    };

    if endpoints.is_empty() {
        return Err(StatusCode::NOT_FOUND);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();

    let msg = build_signed_p2p_message(&state.identity, "chat", &body.message);
    let msg_body = msg.to_string();

    let mut sorted = endpoints;
    sorted.sort_by_key(|e| e.priority);

    for ep in &sorted {
        if ep.transport != "tcp" && ep.transport != "http" {
            continue;
        }
        let is_ipv6 = ep.address.contains(':') && !ep.address.contains('.');
        let host = if is_ipv6 {
            format!("[{}]:{}", ep.address, ep.port)
        } else {
            format!("{}:{}", ep.address, ep.port)
        };
        let url = format!("http://{}/peer/message", host);
        let headers =
            sign_http_request(&state.identity, "POST", &host, "/peer/message", &msg_body);

        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("X-AgentWorld-Version", &headers.version)
            .header("X-AgentWorld-From", &headers.from_agent)
            .header("X-AgentWorld-KeyId", &headers.key_id)
            .header("X-AgentWorld-Timestamp", &headers.timestamp)
            .header("Content-Digest", &headers.content_digest)
            .header("X-AgentWorld-Signature", &headers.signature)
            .body(msg_body.clone())
            .send()
            .await;

        let Ok(resp) = resp else { continue };
        if !resp.status().is_success() {
            continue;
        }
        // Verify that the responder is who we addressed; skip endpoint if not.
        let from_hdr = resp
            .headers()
            .get("x-agentworld-from")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !from_hdr.is_empty() && from_hdr != body.agent_id {
            continue;
        }
        return Ok(Json(OkResponse {
            ok: true,
            message: Some(format!("Message sent to {}", body.agent_id)),
        }));
    }

    Err(StatusCode::BAD_GATEWAY)
}

/// Resolve a world identifier (worldId or slug or direct address) to
/// (address, port, publicKey, worldId, slug).
async fn resolve_world(
    client: &reqwest::Client,
    gateway_url: &str,
    identifier: &str,
) -> Result<(String, u16, String, String, Option<String>), String> {
    // Direct address format: "host:port" or "host"
    if !identifier.starts_with("aw:") && identifier.contains(':') && !identifier.starts_with("http") {
        let parts: Vec<&str> = identifier.rsplitn(2, ':').collect();
        if parts.len() == 2 {
            if let Ok(p) = parts[0].parse::<u16>() {
                return Ok((parts[1].trim_matches('[').trim_matches(']').to_string(), p, String::new(), identifier.to_string(), None));
            }
        }
        return Ok((identifier.to_string(), 8099, String::new(), identifier.to_string(), None));
    }

    // Try direct worldId lookup
    let url = format!("{}/worlds/{}", gateway_url.trim_end_matches('/'), urlencoding(identifier));
    if let Ok(resp) = client.get(&url).send().await {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<serde_json::Value>().await {
                if let Some(ep) = best_endpoint(&data) {
                    let public_key = data.get("publicKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let world_id = data.get("worldId").and_then(|v| v.as_str()).unwrap_or(identifier).to_string();
                    let slug = data.get("slug").and_then(|v| v.as_str()).map(|s| s.to_string());
                    return Ok((ep.address, ep.port, public_key, world_id, slug));
                }
            }
        }
    }

    // Fallback: list all worlds and search by slug
    let all_url = format!("{}/worlds", gateway_url.trim_end_matches('/'));
    if let Ok(resp) = client.get(&all_url).send().await {
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            if let Some(worlds) = data.get("worlds").and_then(|w| w.as_array()) {
                for w in worlds {
                    let slug = w.get("slug").and_then(|v| v.as_str()).unwrap_or("");
                    let wid = w.get("worldId").and_then(|v| v.as_str()).unwrap_or("");
                    if slug == identifier || wid == identifier {
                        if let Some(ep) = best_endpoint(w) {
                            let public_key = w.get("publicKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            return Ok((ep.address, ep.port, public_key, wid.to_string(), Some(slug.to_string())));
                        }
                    }
                }
            }
        }
    }

    Err(format!("World '{}' not found", identifier))
}

fn best_endpoint(world_data: &serde_json::Value) -> Option<Endpoint> {
    let endpoints: Vec<Endpoint> = world_data
        .get("endpoints")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if endpoints.is_empty() {
        return None;
    }
    let mut sorted = endpoints;
    sorted.sort_by_key(|e| e.priority);
    sorted.into_iter().find(|e| e.transport == "tcp" || e.transport == "http")
        .or_else(|| {
            let mut sorted2: Vec<Endpoint> = world_data
                .get("endpoints")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            sorted2.sort_by_key(|e| e.priority);
            sorted2.into_iter().next()
        })
}

fn public_key_to_agent_id(public_key_b64: &str) -> String {
    crate::crypto::agent_id_from_public_key(public_key_b64).unwrap_or_default()
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => vec![c],
            _ => format!("%{:02X}", c as u32).chars().collect(),
        })
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

pub fn ipc_port() -> u16 {
    std::env::var("AWN_IPC_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_IPC_PORT)
}

pub fn default_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".awn")
}

pub fn default_gateway_url() -> String {
    std::env::var("GATEWAY_URL").unwrap_or_else(|_| "https://gateway.agentworlds.ai".to_string())
}

pub fn write_port_file(data_dir: &std::path::Path, port: u16) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(data_dir.join(PORT_FILE), port.to_string());
}

pub fn read_port_file(data_dir: &std::path::Path) -> Option<u16> {
    std::fs::read_to_string(data_dir.join(PORT_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

pub fn remove_port_file(data_dir: &std::path::Path) {
    let _ = std::fs::remove_file(data_dir.join(PORT_FILE));
}

pub fn write_pid_file(data_dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(data_dir.join(PID_FILE), std::process::id().to_string());
}

pub fn read_pid_file(data_dir: &std::path::Path) -> Option<u32> {
    std::fs::read_to_string(data_dir.join(PID_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

pub fn remove_pid_file(data_dir: &std::path::Path) {
    let _ = std::fs::remove_file(data_dir.join(PID_FILE));
}

#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    #[error("identity error: {0}")]
    Identity(String),
    #[error("bind error: {0}")]
    Bind(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_daemon_starts_and_responds_to_ping() {
        let tmp = TempDir::new().unwrap();
        let handle = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            0,
            0,
            None, // OS-assigned port
        )
        .await
        .unwrap();

        let url = format!("http://{}/ipc/ping", handle.addr);
        let resp: OkResponse = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert!(resp.ok);

        handle.shutdown();
    }

    #[tokio::test]
    async fn test_daemon_status_returns_identity() {
        let tmp = TempDir::new().unwrap();
        let handle = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            0,
            0,
            None,
        )
        .await
        .unwrap();

        let url = format!("http://{}/ipc/status", handle.addr);
        let resp: StatusResponse = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert!(resp.agent_id.starts_with("aw:sha256:"));
        assert_eq!(resp.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(resp.listen_port, handle.peer_addr.port());

        handle.shutdown();
    }

    #[tokio::test]
    async fn test_daemon_agents_empty() {
        let tmp = TempDir::new().unwrap();
        let handle = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            0,
            0,
            None,
        )
        .await
        .unwrap();

        let url = format!("http://{}/ipc/agents", handle.addr);
        let resp: AgentsResponse = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert!(resp.agents.is_empty());

        handle.shutdown();
    }

    #[tokio::test]
    async fn test_daemon_creates_identity_file() {
        let tmp = TempDir::new().unwrap();
        let handle = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            0,
            0,
            None,
        )
        .await
        .unwrap();

        assert!(tmp.path().join("identity.json").exists());
        handle.shutdown();
    }

    #[tokio::test]
    async fn test_daemon_reuses_identity() {
        let tmp = TempDir::new().unwrap();

        let handle1 = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            0,
            0,
            None,
        )
        .await
        .unwrap();
        let url1 = format!("http://{}/ipc/status", handle1.addr);
        let resp1: StatusResponse = reqwest::get(&url1).await.unwrap().json().await.unwrap();
        handle1.shutdown();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let handle2 = start_daemon(
            tmp.path().to_path_buf(),
            "http://localhost:9999".to_string(),
            0,
            0,
            None,
        )
        .await
        .unwrap();
        let url2 = format!("http://{}/ipc/status", handle2.addr);
        let resp2: StatusResponse = reqwest::get(&url2).await.unwrap().json().await.unwrap();
        handle2.shutdown();

        assert_eq!(resp1.agent_id, resp2.agent_id);
    }
}
