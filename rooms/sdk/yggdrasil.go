package sdk

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// YggMode controls how Yggdrasil connectivity is established.
type YggMode int

const (
	YggModeAuto     YggMode = iota // Try External first, then Embedded
	YggModeExternal                // Use a pre-running Yggdrasil daemon
	YggModeEmbedded                // Start embedded Yggdrasil (requires TUN / Docker cap_add)
	YggModeEnvAddr                 // Read YGGDRASIL_ADDR env var (testing only)
)

// YggdrasilManager handles Yggdrasil connectivity in one of multiple modes.
type YggdrasilManager struct {
	Mode    YggMode
	DataDir string
	addr    string
}

// Start establishes Yggdrasil connectivity and returns the 200::/7 address.
func (m *YggdrasilManager) Start() (string, error) {
	switch m.Mode {
	case YggModeEnvAddr:
		return m.startEnvAddr()
	case YggModeExternal:
		return m.startExternal()
	case YggModeEmbedded:
		return m.startEmbedded()
	case YggModeAuto:
		// 1. Try YGGDRASIL_ADDR env (fastest for testing)
		if addr := os.Getenv("YGGDRASIL_ADDR"); addr != "" {
			log.Printf("[yggdrasil] Using YGGDRASIL_ADDR=%s", addr)
			m.addr = addr
			return addr, nil
		}
		// 2. Try external daemon
		if addr, err := m.startExternal(); err == nil {
			return addr, nil
		}
		// 3. Try embedded
		return m.startEmbedded()
	}
	return "", fmt.Errorf("unknown YggMode %d", m.Mode)
}

// Addr returns the Yggdrasil address obtained after Start().
func (m *YggdrasilManager) Addr() string { return m.addr }

// ── External daemon mode ─────────────────────────────────────────────────────

func (m *YggdrasilManager) startExternal() (string, error) {
	// Try yggdrasilctl via default socket
	endpoints := []string{
		"/var/run/yggdrasil/yggdrasil.sock",
		"/var/run/yggdrasil.sock",
		"unix:///var/run/yggdrasil/yggdrasil.sock",
	}
	for _, ep := range endpoints {
		if addr, err := queryYggdrasilAddr(ep); err == nil {
			log.Printf("[yggdrasil] External daemon: %s", addr)
			m.addr = addr
			return addr, nil
		}
	}
	return "", fmt.Errorf("no external Yggdrasil daemon found")
}

func queryYggdrasilAddr(endpoint string) (string, error) {
	args := []string{"getself"}
	if endpoint != "" {
		args = append([]string{"-endpoint=" + endpoint}, args...)
	}
	out, err := exec.Command("yggdrasilctl", args...).Output()
	if err != nil {
		return "", err
	}
	var result struct {
		Address string `json:"address"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		// try plain text output
		lines := strings.Split(string(out), "\n")
		for _, l := range lines {
			if strings.Contains(l, "IPv6 address") || strings.Contains(l, "address") {
				parts := strings.Fields(l)
				for _, p := range parts {
					if strings.HasPrefix(p, "2") && strings.Contains(p, ":") {
						return strings.TrimRight(p, ","), nil
					}
				}
			}
		}
		return "", fmt.Errorf("could not parse yggdrasilctl output")
	}
	if result.Address == "" {
		return "", fmt.Errorf("empty address from yggdrasilctl")
	}
	return result.Address, nil
}

// ── Embedded mode ────────────────────────────────────────────────────────────

func (m *YggdrasilManager) startEmbedded() (string, error) {
	// Check for yggdrasil binary (embedded via subprocess, not Go library)
	// Using subprocess approach for simplicity and compatibility.
	// Full Go library embedding requires TUN which needs cap_add NET_ADMIN in Docker.
	if _, err := exec.LookPath("yggdrasil"); err != nil {
		return "", fmt.Errorf("yggdrasil binary not found — install from https://yggdrasil-network.github.io/installation.html")
	}

	confFile, err := m.writeYggConfig()
	if err != nil {
		return "", fmt.Errorf("write yggdrasil config: %w", err)
	}

	logFile := confFile[:len(confFile)-5] + ".log"
	logFd, err := os.Create(logFile)
	if err != nil {
		return "", err
	}

	cmd := exec.Command("yggdrasil", "-useconffile", confFile)
	cmd.Stdout = logFd
	cmd.Stderr = logFd
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start yggdrasil: %w", err)
	}

	log.Printf("[yggdrasil] Starting daemon (embedded mode)...")

	// Wait for address to appear in log
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(time.Second)
		data, _ := os.ReadFile(logFile)
		content := string(data)
		if strings.Contains(content, "panic:") || strings.Contains(content, "failed to open /dev/net/tun") {
			return "", fmt.Errorf("yggdrasil TUN failed — container needs --cap-add NET_ADMIN and --device /dev/net/tun")
		}
		if idx := strings.Index(content, "Your IPv6 address is "); idx >= 0 {
			rest := content[idx+len("Your IPv6 address is "):]
			addr := strings.Fields(rest)[0]
			log.Printf("[yggdrasil] Address: %s", addr)
			m.addr = addr
			return addr, nil
		}
	}
	return "", fmt.Errorf("yggdrasil did not obtain an address within 30s")
}

func (m *YggdrasilManager) writeYggConfig() (string, error) {
	if err := os.MkdirAll(m.DataDir, 0700); err != nil {
		return "", err
	}
	confFile := fmt.Sprintf("%s/yggdrasil.conf", m.DataDir)

	out, err := exec.Command("yggdrasil", "-genconf").Output()
	if err != nil {
		return "", err
	}
	conf := string(out)

	// Configure TUN and admin
	conf = replaceField(conf, "IfName:", "auto")
	conf = replaceField(conf, "AdminListen:", `"tcp://127.0.0.1:9001"`)

	// Inject public peers
	peers := []string{
		`"tcp://yggdrasil.mnpnk.com:10002"`,
		`"tcp://ygg.mkg20001.io:80"`,
		`"tcp://46.246.86.205:60002"`,
	}
	peersBlock := "Peers: [\n    " + strings.Join(peers, ",\n    ") + "\n  ]"
	conf = strings.Replace(conf, "Peers: []", peersBlock, 1)

	return confFile, os.WriteFile(confFile, []byte(conf), 0600)
}

func replaceField(conf, field, value string) string {
	lines := strings.Split(conf, "\n")
	for i, l := range lines {
		trimmed := strings.TrimSpace(l)
		if strings.HasPrefix(trimmed, field) {
			indent := l[:len(l)-len(strings.TrimLeft(l, " \t"))]
			lines[i] = indent + field + " " + value
		}
	}
	return strings.Join(lines, "\n")
}

// ── Env addr mode ────────────────────────────────────────────────────────────

func (m *YggdrasilManager) startEnvAddr() (string, error) {
	addr := os.Getenv("YGGDRASIL_ADDR")
	if addr == "" {
		return "", fmt.Errorf("YGGDRASIL_ADDR not set")
	}
	m.addr = addr
	log.Printf("[yggdrasil] Using env addr: %s", addr)
	return addr, nil
}
