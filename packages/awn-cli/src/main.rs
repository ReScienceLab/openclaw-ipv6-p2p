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
        /// Listen port for the agent server
        #[arg(long, default_value_t = 8099)]
        port: u16,
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
            } => {
                let data_dir = data_dir.unwrap_or_else(daemon::default_data_dir);
                let gateway_url = gateway_url.unwrap_or_else(daemon::default_gateway_url);
                let ipc_port = cli_ipc_port.unwrap_or_else(|| daemon::ipc_port());

                match daemon::start_daemon(data_dir.clone(), gateway_url, port, ipc_port).await {
                    Ok(handle) => {
                        daemon::write_port_file(&data_dir, handle.addr.port());
                        daemon::write_pid_file(&data_dir);
                        if json_output {
                            println!(
                                "{}",
                                serde_json::json!({
                                    "ok": true,
                                    "ipc_addr": handle.addr.to_string()
                                })
                            );
                        } else {
                            eprintln!("AWN daemon listening on {}", handle.addr);
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
