mod crypto;
mod daemon;
mod identity;
mod agent_db;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "awn", version, about = "Agent World Network — standalone CLI for world-scoped P2P messaging")]
struct Cli {
    /// Output JSON instead of human-readable text
    #[arg(long, global = true)]
    json: bool,

    /// IPC port for CLI ↔ daemon communication (overrides AWN_IPC_PORT and saved port file)
    #[arg(long, global = true)]
    ipc_port: Option<u16>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start or stop the AWN background daemon
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },
    /// Show this agent's identity, transport, and status
    Status,
    /// List known agents
    Agents {
        /// Filter by capability prefix (e.g. "world:")
        #[arg(long)]
        capability: Option<String>,
    },
    /// List available worlds from the Gateway
    Worlds,
    /// Get detailed info about a specific world
    World {
        /// World ID or slug to query
        world_id: String,
    },
    /// List currently joined worlds
    Joined,
    /// Join a world by world ID, slug, or direct address (host:port)
    Join {
        /// World ID, slug, or direct address
        world_id: String,
    },
    /// Leave a joined world
    Leave {
        /// World ID or slug to leave
        world_id: String,
    },
    /// Ping an agent to check reachability
    Ping {
        /// Agent ID to ping
        agent_id: String,
    },
    /// Send a direct P2P message to an agent
    Send {
        /// Target agent ID
        agent_id: String,
        /// Message text
        message: String,
    },
}

#[derive(Subcommand)]
enum DaemonAction {
    /// Start the AWN daemon
    Start {
        /// Data directory for identity and agent DB
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Gateway URL
        #[arg(long)]
        gateway_url: Option<String>,
        /// Listen port for the peer server
        #[arg(long, default_value_t = 8099)]
        port: u16,
        /// Public address to advertise in world.join (e.g. a VPN IP or hostname).
        /// Defaults to 127.0.0.1 (local-only). Set this so world members can reach you.
        #[arg(long)]
        advertise_address: Option<String>,
    },
    /// Stop the AWN daemon
    Stop,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let json_output = cli.json;
    let cli_ipc_port = cli.ipc_port;

    match cli.command {
        Commands::Daemon { action } => match action {
            DaemonAction::Start {
                data_dir,
                gateway_url,
                port,
                advertise_address,
            } => {
                let data_dir = data_dir.unwrap_or_else(daemon::default_data_dir);
                let gateway_url = gateway_url.unwrap_or_else(daemon::default_gateway_url);
                let ipc_port = cli_ipc_port.unwrap_or_else(|| daemon::ipc_port());

                match daemon::start_daemon(data_dir.clone(), gateway_url, port, ipc_port, advertise_address).await {
                    Ok(handle) => {
                        daemon::write_port_file(&data_dir, handle.addr.port());
                        daemon::write_pid_file(&data_dir);
                        if json_output {
                            println!(
                                "{}",
                                serde_json::json!({
                                    "ok": true,
                                    "ipc_addr": handle.addr.to_string(),
                                    "peer_addr": handle.peer_addr.to_string(),
                                })
                            );
                        } else {
                            eprintln!("AWN daemon IPC listening on {}", handle.addr);
                            eprintln!("AWN peer server listening on {}", handle.peer_addr);
                            eprintln!("Press Ctrl+C to stop");
                        }
                        tokio::signal::ctrl_c().await.ok();
                        daemon::remove_port_file(&data_dir);
                        daemon::remove_pid_file(&data_dir);
                        handle.shutdown();
                        if !json_output {
                            eprintln!("Daemon stopped");
                        }
                    }
                    Err(e) => {
                        if json_output {
                            println!("{}", serde_json::json!({"error": e.to_string()}));
                        } else {
                            eprintln!("Error: {e}");
                        }
                        std::process::exit(1);
                    }
                }
            }
            DaemonAction::Stop => {
                let data_dir = daemon::default_data_dir();
                let ipc = resolve_ipc_port_raw(cli_ipc_port);
                let url = format!("http://127.0.0.1:{ipc}/ipc/shutdown");
                let client = reqwest::Client::new();
                match client.post(&url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        daemon::remove_port_file(&data_dir);
                        daemon::remove_pid_file(&data_dir);
                        if json_output {
                            println!("{}", serde_json::json!({"ok": true, "message": "daemon stopped"}));
                        } else {
                            println!("Daemon stopped.");
                        }
                    }
                    _ => {
                        // Fallback: try to kill by PID
                        if let Some(pid) = daemon::read_pid_file(&data_dir) {
                            unsafe {
                                if libc::kill(pid as i32, libc::SIGTERM) == 0 {
                                    daemon::remove_port_file(&data_dir);
                                    daemon::remove_pid_file(&data_dir);
                                    if json_output {
                                        println!("{}", serde_json::json!({"ok": true, "message": format!("sent SIGTERM to pid {pid}")}));
                                    } else {
                                        println!("Sent SIGTERM to daemon (pid {pid}).");
                                    }
                                    return;
                                }
                            }
                        }
                        if json_output {
                            println!("{}", serde_json::json!({"error": "daemon not running"}));
                        } else {
                            eprintln!("Daemon not running.");
                        }
                        std::process::exit(1);
                    }
                }
            }
        },
        Commands::Status => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let url = format!("http://127.0.0.1:{ipc}/ipc/status");
            match reqwest::get(&url).await {
                Ok(resp) => {
                    if let Ok(status) = resp.json::<daemon::StatusResponse>().await {
                        if json_output {
                            println!("{}", serde_json::to_string(&status).unwrap());
                        } else {
                            println!("=== AWN Status ===");
                            println!("Agent ID:      {}", status.agent_id);
                            println!("Version:       v{}", status.version);
                            println!("Listen port:   {}", status.listen_port);
                            println!("Gateway:       {}", status.gateway_url);
                            println!("Known agents:  {}", status.known_agents);
                            println!("Data dir:      {}", status.data_dir);
                        }
                    }
                }
                Err(_) => {
                    if json_output {
                        println!("{}", serde_json::json!({"error": "AWN daemon not running. Start with: awn daemon start"}));
                    } else {
                        eprintln!("AWN daemon not running. Start with: awn daemon start");
                    }
                    std::process::exit(1);
                }
            }
        }
        Commands::Agents { ref capability } => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let mut url = format!("http://127.0.0.1:{ipc}/ipc/agents");
            if let Some(cap) = capability {
                url = format!("{url}?capability={}", urlencoding(cap));
            }
            match reqwest::get(&url).await {
                Ok(resp) => {
                    if let Ok(data) = resp.json::<daemon::AgentsResponse>().await {
                        if json_output {
                            println!("{}", serde_json::to_string(&data).unwrap());
                        } else if data.agents.is_empty() {
                            println!("No agents found.");
                        } else {
                            println!("=== Known Agents ({}) ===", data.agents.len());
                            for a in &data.agents {
                                let alias = if a.alias.is_empty() {
                                    String::new()
                                } else {
                                    format!(" — {}", a.alias)
                                };
                                let caps = if a.capabilities.is_empty() {
                                    String::new()
                                } else {
                                    format!(" [{}]", a.capabilities.join(", "))
                                };
                                let ago = (now_ms().saturating_sub(a.last_seen)) / 1000;
                                println!("  {}{}{} — {}s ago", a.agent_id, alias, caps, ago);
                            }
                        }
                    }
                }
                Err(_) => {
                    if json_output {
                        println!("{}", serde_json::json!({"error": "AWN daemon not running. Start with: awn daemon start"}));
                    } else {
                        eprintln!("AWN daemon not running. Start with: awn daemon start");
                    }
                    std::process::exit(1);
                }
            }
        }
        Commands::Worlds => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let url = format!("http://127.0.0.1:{ipc}/ipc/worlds");
            match reqwest::get(&url).await {
                Ok(resp) => {
                    if let Ok(data) = resp.json::<daemon::WorldsResponse>().await {
                        if json_output {
                            println!("{}", serde_json::to_string(&data).unwrap());
                        } else if data.worlds.is_empty() {
                            println!("No worlds found.");
                        } else {
                            println!("=== Available Worlds ({}) ===", data.worlds.len());
                            for w in &data.worlds {
                                let status = if w.reachable { "reachable" } else { "no endpoint" };
                                let ago = (now_ms().saturating_sub(w.last_seen)) / 1000;
                                println!("  world:{} — {} [{}] — {}s ago", w.world_id, w.name, status, ago);
                            }
                        }
                    }
                }
                Err(_) => {
                    if json_output {
                        println!("{}", serde_json::json!({"error": "AWN daemon not running. Start with: awn daemon start"}));
                    } else {
                        eprintln!("AWN daemon not running. Start with: awn daemon start");
                    }
                    std::process::exit(1);
                }
            }
        }
        Commands::Joined => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let url = format!("http://127.0.0.1:{ipc}/ipc/joined");
            match reqwest::get(&url).await {
                Ok(resp) => {
                    if let Ok(data) = resp.json::<daemon::JoinedWorldsResponse>().await {
                        if json_output {
                            println!("{}", serde_json::to_string(&data).unwrap());
                        } else if data.worlds.is_empty() {
                            println!("Not joined any worlds. Use: awn join <world_id>");
                        } else {
                            println!("=== Joined Worlds ({}) ===", data.worlds.len());
                            for w in &data.worlds {
                                let label = w.slug.as_deref().unwrap_or(&w.world_id);
                                println!("  {} — {} ({}:{})", label, w.name, w.address, w.port);
                            }
                        }
                    }
                }
                Err(_) => {
                    if json_output {
                        println!("{}", serde_json::json!({"error": "AWN daemon not running"}));
                    } else {
                        eprintln!("AWN daemon not running. Start with: awn daemon start");
                    }
                    std::process::exit(1);
                }
            }
        }
        Commands::Join { ref world_id } => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let encoded_id = urlencoding(world_id);
            let url = format!("http://127.0.0.1:{ipc}/ipc/join/{encoded_id}");
            let client = reqwest::Client::new();
            match client.post(&url).send().await {
                Ok(resp) => {
                    if resp.status().is_success() {
                        if let Ok(data) = resp.json::<serde_json::Value>().await {
                            if json_output {
                                println!("{}", data);
                            } else {
                                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or(world_id);
                                let members = data.get("members").and_then(|v| v.as_u64()).unwrap_or(0);
                                let wid = data.get("worldId").and_then(|v| v.as_str()).unwrap_or(world_id);
                                println!("Joined world: {} — {} ({} members)", wid, name, members);
                            }
                        }
                    } else {
                        if json_output {
                            println!("{}", serde_json::json!({"error": format!("Failed to join world: {}", world_id)}));
                        } else {
                            eprintln!("Failed to join world '{}'. Check that the world ID or address is correct.", world_id);
                        }
                        std::process::exit(1);
                    }
                }
                Err(_) => {
                    if json_output {
                        println!("{}", serde_json::json!({"error": "AWN daemon not running"}));
                    } else {
                        eprintln!("AWN daemon not running. Start with: awn daemon start");
                    }
                    std::process::exit(1);
                }
            }
        }
        Commands::Leave { ref world_id } => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let encoded_id = urlencoding(world_id);
            let url = format!("http://127.0.0.1:{ipc}/ipc/leave/{encoded_id}");
            let client = reqwest::Client::new();
            match client.post(&url).send().await {
                Ok(resp) => {
                    if resp.status().is_success() {
                        if json_output {
                            println!("{}", serde_json::json!({"ok": true}));
                        } else {
                            println!("Left world '{}'.", world_id);
                        }
                    } else if resp.status() == reqwest::StatusCode::NOT_FOUND {
                        if json_output {
                            println!("{}", serde_json::json!({"error": "World not found in joined list"}));
                        } else {
                            eprintln!("World '{}' is not in your joined list.", world_id);
                        }
                        std::process::exit(1);
                    } else {
                        eprintln!("Failed to leave world '{}'.", world_id);
                        std::process::exit(1);
                    }
                }
                Err(_) => {
                    if json_output {
                        println!("{}", serde_json::json!({"error": "AWN daemon not running"}));
                    } else {
                        eprintln!("AWN daemon not running. Start with: awn daemon start");
                    }
                    std::process::exit(1);
                }
            }
        }
        Commands::Ping { ref agent_id } => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let encoded_id = urlencoding(agent_id);
            let url = format!("http://127.0.0.1:{ipc}/ipc/peer/ping/{encoded_id}");
            match reqwest::get(&url).await {
                Ok(resp) => {
                    if let Ok(data) = resp.json::<daemon::PingResponse>().await {
                        if json_output {
                            println!("{}", serde_json::to_string(&data).unwrap());
                        } else if data.ok {
                            let latency = data.latency_ms.map(|ms| format!(" ({}ms)", ms)).unwrap_or_default();
                            println!("Reachable{}", latency);
                        } else {
                            println!("Unreachable: {}", data.error.as_deref().unwrap_or("unknown"));
                        }
                    }
                }
                Err(_) => {
                    if json_output {
                        println!("{}", serde_json::json!({"error": "AWN daemon not running"}));
                    } else {
                        eprintln!("AWN daemon not running. Start with: awn daemon start");
                    }
                    std::process::exit(1);
                }
            }
        }
        Commands::Send { ref agent_id, ref message } => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let url = format!("http://127.0.0.1:{ipc}/ipc/send");
            let client = reqwest::Client::new();
            let body = serde_json::json!({"agent_id": agent_id, "message": message});
            match client.post(&url).json(&body).send().await {
                Ok(resp) => {
                    if resp.status().is_success() {
                        if json_output {
                            println!("{}", serde_json::json!({"ok": true}));
                        } else {
                            println!("Message sent to {}.", agent_id);
                        }
                    } else if resp.status() == reqwest::StatusCode::NOT_FOUND {
                        if json_output {
                            println!("{}", serde_json::json!({"error": "Agent not found or no known endpoints"}));
                        } else {
                            eprintln!("Agent '{}' not found or has no known endpoints. Join a shared world first.", agent_id);
                        }
                        std::process::exit(1);
                    } else {
                        if json_output {
                            println!("{}", serde_json::json!({"error": "Failed to deliver message"}));
                        } else {
                            eprintln!("Failed to deliver message to '{}'.", agent_id);
                        }
                        std::process::exit(1);
                    }
                }
                Err(_) => {
                    if json_output {
                        println!("{}", serde_json::json!({"error": "AWN daemon not running"}));
                    } else {
                        eprintln!("AWN daemon not running. Start with: awn daemon start");
                    }
                    std::process::exit(1);
                }
            }
        }
        Commands::World { ref world_id } => {
            let ipc = resolve_ipc_port_raw(cli_ipc_port);
            let encoded_id = urlencoding(world_id);
            let url = format!("http://127.0.0.1:{ipc}/ipc/world/{encoded_id}");
            match reqwest::get(&url).await {
                Ok(resp) => {
                    if let Ok(data) = resp.json::<daemon::WorldInfoResponse>().await {
                        if cli.json {
                            println!("{}", serde_json::to_string(&data).unwrap());
                        } else {
                            println!("=== World Info ===");
                            println!("World ID:      {}", data.world_id);
                            println!("Name:          {}", data.name);
                            println!("Status:        {}", if data.reachable { "reachable" } else { "no endpoint" });
                            if !data.endpoints.is_empty() {
                                println!("\nEndpoints:");
                                for ep in &data.endpoints {
                                    println!("  {}://{}:{} (priority: {})", ep.transport, ep.address, ep.port, ep.priority);
                                }
                            }
                            if let Some(manifest) = &data.manifest {
                                println!("\nManifest:");
                                println!("  Name:        {}", manifest.name);
                                if let Some(desc) = &manifest.description {
                                    println!("  Description: {}", desc);
                                }
                                if let Some(theme) = &manifest.theme {
                                    println!("  Theme:       {}", theme);
                                }
                                if let Some(actions) = &manifest.actions {
                                    println!("\n  Actions:");
                                    for (action_name, action) in actions {
                                        println!("    {} — {}", action_name, action.desc);
                                        if let Some(params) = &action.params {
                                            for (param_name, param) in params {
                                                let req = if param.required.unwrap_or(false) { "required" } else { "optional" };
                                                println!("      • {} ({}): {}", param_name, param.param_type, req);
                                                if let Some(desc) = &param.desc {
                                                    println!("        {}", desc);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        if cli.json {
                            println!("{}", serde_json::json!({"error": "Failed to parse world info"}));
                        } else {
                            eprintln!("Failed to parse world info");
                        }
                        std::process::exit(1);
                    }
                }
                Err(_) => {
                    if cli.json {
                        println!("{}", serde_json::json!({"error": "Failed to fetch world info"}));
                    } else {
                        eprintln!("Failed to fetch world info. Make sure the daemon is running and the world ID is correct.");
                    }
                    std::process::exit(1);
                }
            }
        }
    }
}

fn resolve_ipc_port_raw(cli_ipc_port: Option<u16>) -> u16 {
    if let Some(port) = cli_ipc_port {
        return port;
    }
    if let Ok(port) = std::env::var("AWN_IPC_PORT").and_then(|s| s.parse().map_err(|_| std::env::VarError::NotPresent)) {
        return port;
    }
    daemon::read_port_file(&daemon::default_data_dir()).unwrap_or_else(|| daemon::ipc_port())
}

fn urlencoding(s: &str) -> String {
    s.replace(':', "%3A")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
