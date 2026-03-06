package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Room is the interface every game/activity must implement.
type Room interface {
	OnParticipantJoin(seat string, info ParticipantInfo) error
	OnAction(seat string, action json.RawMessage) error
	OnParticipantLeave(seat string) error
	// GetInitialState returns a JSON-serializable full state snapshot
	// sent to new WebSocket dashboard connections.
	GetInitialState() any
	// GetRoomMeta returns metadata broadcast in the peer announcement alias.
	GetRoomMeta() RoomMeta
	// OnLobbyComplete is called after the lobby fills (or times out).
	OnLobbyComplete() error
}

// RoomMeta describes a room in the DeClaw peer network.
type RoomMeta struct {
	Type     string `json:"type"`
	Slots    int    `json:"slots"`
	Occupied int    `json:"occupied"`
	Waiting  bool   `json:"waiting"`
}

// ParticipantInfo holds information about a joining participant.
type ParticipantInfo struct {
	YggAddr string
	Name    string
	IsBot   bool
}

// ParticipantRecord stores live data about a seated participant.
type ParticipantRecord struct {
	YggAddr string
	Name    string
	IsBot   bool
}

// ServerConfig configures a Room Server.
type ServerConfig struct {
	Room          Room
	Name          string
	Slots         int
	DataDir       string
	Port          int // DeClaw peer server port (default 8099)
	DashPort      int // Dashboard HTTP port (default 8080)
	YggMode       YggMode
	DashStaticDir string // path to dashboard/ static files
	// TestMode skips Yggdrasil address verification (for local dev/testing)
	TestMode bool
}

// Server manages Yggdrasil, the DeClaw peer server, dashboard, and lobby.
type Server struct {
	cfg ServerConfig

	Identity *Identity
	YggAddr  string

	ygg        *YggdrasilManager
	peerServer *PeerServer
	db         *PeerDB
	dashboard  *DashboardServer

	mu           sync.RWMutex
	participants map[string]*ParticipantRecord // seat → record
	seats        []string

	lobbyDone chan struct{}
	lobbyOnce sync.Once

	// pendingActions: seat → chan json.RawMessage
	pendingActions sync.Map
}

// NewServer creates a new Room Server from the given config.
func NewServer(cfg ServerConfig) *Server {
	if cfg.Port == 0 {
		cfg.Port = 8099
	}
	if cfg.DashPort == 0 {
		cfg.DashPort = 8080
	}
	if cfg.DataDir == "" {
		cfg.DataDir = fmt.Sprintf("/tmp/declaw-room-%s", cfg.Name)
	}
	if cfg.Slots == 0 {
		cfg.Slots = 4
	}
	seats := make([]string, cfg.Slots)
	defaults := []string{"east", "south", "west", "north"}
	for i := 0; i < cfg.Slots; i++ {
		if i < len(defaults) {
			seats[i] = defaults[i]
		} else {
			seats[i] = fmt.Sprintf("seat%d", i+1)
		}
	}
	return &Server{
		cfg:          cfg,
		seats:        seats,
		participants: make(map[string]*ParticipantRecord),
		lobbyDone:    make(chan struct{}),
	}
}

// Start initialises everything and blocks until context is cancelled.
func (s *Server) Start(ctx context.Context) error {
	if err := os.MkdirAll(s.cfg.DataDir, 0700); err != nil {
		return err
	}

	// 1. Identity
	id, err := LoadOrCreateIdentity(s.cfg.DataDir)
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	s.Identity = id
	log.Printf("[room] Agent ID: %s", id.AgentID)

	// 2. Yggdrasil
	s.ygg = &YggdrasilManager{Mode: s.cfg.YggMode, DataDir: filepath.Join(s.cfg.DataDir, "yggdrasil")}
	addr, err := s.ygg.Start()
	if err != nil {
		return fmt.Errorf("yggdrasil: %w", err)
	}
	s.YggAddr = addr
	s.Identity.YggIpv6 = addr
	log.Printf("[room] Yggdrasil: %s", addr)

	// 3. Peer server
	s.db = newPeerDB()
	s.peerServer = newPeerServer(s.Identity, s.cfg.TestMode)
	s.peerServer.db = s.db
	s.peerServer.OnMessage(s.handleIncomingMessage)
	if err := s.peerServer.Start(s.cfg.Port); err != nil {
		return fmt.Errorf("peer server: %w", err)
	}
	s.updateSelfMeta()

	// 4. Dashboard
	staticDir := s.cfg.DashStaticDir
	if staticDir == "" {
		staticDir = filepath.Join(filepath.Dir(os.Args[0]), "dashboard")
	}
	s.dashboard = newDashboard(s.cfg.DashPort, staticDir)
	if err := s.dashboard.Start(); err != nil {
		log.Printf("[room] Dashboard warning: %v", err)
	}

	// 5. Bootstrap discovery
	log.Printf("[room] Bootstrapping onto DeClaw network as %q...", s.cfg.Name)
	go func() {
		BootstrapDiscovery(s.Identity, s.db, s.cfg.Port, nil, AnnounceMeta{
			Name:    s.cfg.Name,
			Version: "0.1.0",
		})
	}()

	// 6. Publish address to /shared if running in Docker Compose
	if _, err := os.Stat("/shared"); err == nil {
		_ = os.WriteFile("/shared/host.addr", []byte(addr), 0644)
		log.Printf("[room] Address published → /shared/host.addr")
	}

	log.Printf("[room] %q ready at %s", s.cfg.Name, addr)
	log.Printf("[room] Dashboard: http://[%s]:%d", addr, s.cfg.DashPort)

	// 7. Open lobby (blocks until full or timeout)
	go s.runLobby(ctx)

	// Block until context cancelled
	<-ctx.Done()
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.peerServer.Stop(shutCtx)
	_ = s.dashboard.Stop(shutCtx)
	return nil
}

func (s *Server) runLobby(ctx context.Context) {
	log.Printf("[room] Lobby open — waiting up to 90s for %d players", s.cfg.Slots)
	select {
	case <-s.lobbyDone:
		log.Printf("[room] Lobby full")
	case <-time.After(90 * time.Second):
		log.Printf("[room] Lobby timeout — filling with bots")
	case <-ctx.Done():
		return
	}
	if err := s.cfg.Room.OnLobbyComplete(); err != nil {
		log.Printf("[room] OnLobbyComplete error: %v", err)
	}
}

// ── SDK public API ────────────────────────────────────────────────────────────

// Send sends a DeClaw P2P event to a specific seat.
func (s *Server) Send(seat string, event any) error {
	s.mu.RLock()
	p := s.participants[seat]
	s.mu.RUnlock()
	if p == nil || p.IsBot {
		return nil
	}
	content, err := json.Marshal(event)
	if err != nil {
		return err
	}
	s.logP2P(s.YggAddr, p.YggAddr, event)
	return SendP2PMessage(s.Identity, p.YggAddr, "room:event", string(content), s.cfg.Port)
}

// Broadcast sends an event to all real (non-bot) participants.
func (s *Server) Broadcast(event any) {
	s.mu.RLock()
	seats := make([]string, 0, len(s.participants))
	for seat := range s.participants {
		seats = append(seats, seat)
	}
	s.mu.RUnlock()
	for _, seat := range seats {
		_ = s.Send(seat, event)
	}
}

// BroadcastWS pushes an event to all connected dashboard WebSocket clients.
func (s *Server) BroadcastWS(event any) {
	if s.dashboard != nil {
		s.dashboard.Broadcast(event)
	}
}

// WaitForAction waits for the next action from a given seat with a timeout.
// Returns nil on timeout.
func (s *Server) WaitForAction(seat string, timeout time.Duration) json.RawMessage {
	ch := make(chan json.RawMessage, 1)
	s.pendingActions.Store(seat, ch)
	defer s.pendingActions.Delete(seat)

	select {
	case action := <-ch:
		return action
	case <-time.After(timeout):
		return nil
	}
}

// Participants returns a copy of the current participant map.
func (s *Server) Participants() map[string]*ParticipantRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	copy := make(map[string]*ParticipantRecord, len(s.participants))
	for k, v := range s.participants {
		rec := *v
		copy[k] = &rec
	}
	return copy
}

// SeatOf returns the seat name for a given Yggdrasil address.
func (s *Server) SeatOf(yggAddr string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for seat, p := range s.participants {
		if p.YggAddr == yggAddr {
			return seat
		}
	}
	return ""
}

// ── Message dispatch ──────────────────────────────────────────────────────────

func (s *Server) handleIncomingMessage(msg P2PMessage, verified bool) {
	if !verified {
		return
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal([]byte(msg.Content), &data); err != nil {
		return
	}
	msgType, _ := jsonString(data["type"])

	switch msg.Event {
	case "room:join":
		name, _ := jsonString(data["name"])
		if name == "" {
			name = msg.FromYgg[:min(12, len(msg.FromYgg))]
		}
		s.handleJoin(msg.FromYgg, name)

	case "room:action":
		seat := s.SeatOf(msg.FromYgg)
		if seat == "" {
			return
		}
		s.logP2P(msg.FromYgg, s.YggAddr, map[string]any{"type": msgType})
		// Resolve pending WaitForAction
		if v, ok := s.pendingActions.Load(seat); ok {
			ch := v.(chan json.RawMessage)
			actionRaw := data["action"]
			if actionRaw == nil {
				actionRaw = []byte(msg.Content)
			}
			select {
			case ch <- actionRaw:
			default:
			}
		}
		actionRaw := data["action"]
		if actionRaw == nil {
			actionRaw = []byte(msg.Content)
		}
		go func() {
			if err := s.cfg.Room.OnAction(seat, actionRaw); err != nil {
				log.Printf("[room] OnAction(%s): %v", seat, err)
			}
		}()

	case "room:leave":
		seat := s.SeatOf(msg.FromYgg)
		if seat != "" {
			s.handleLeave(seat)
		}
	}
}

func (s *Server) handleJoin(yggAddr, name string) {
	s.mu.Lock()
	// Check already registered
	for _, p := range s.participants {
		if p.YggAddr == yggAddr {
			s.mu.Unlock()
			return
		}
	}
	// Find next empty seat
	var seat string
	for _, candidate := range s.seats {
		if _, taken := s.participants[candidate]; !taken {
			seat = candidate
			break
		}
	}
	if seat == "" {
		s.mu.Unlock()
		log.Printf("[room] Join from %s rejected — room full", yggAddr[:min(20, len(yggAddr))])
		return
	}
	s.participants[seat] = &ParticipantRecord{YggAddr: yggAddr, Name: name}
	occupied := len(s.participants)
	s.mu.Unlock()

	s.logP2P(yggAddr, s.YggAddr, map[string]any{"type": "room:join", "name": name})
	s.updateSelfMeta()
	log.Printf("[room] %s joined as %s (%d/%d)", name, seat, occupied, s.cfg.Slots)

	if err := s.cfg.Room.OnParticipantJoin(seat, ParticipantInfo{YggAddr: yggAddr, Name: name}); err != nil {
		log.Printf("[room] OnParticipantJoin(%s): %v", seat, err)
	}

	// Send welcome
	_ = s.Send(seat, map[string]any{
		"type":         "room:welcome",
		"role":         seat,
		"dashboardUrl": fmt.Sprintf("http://[%s]:%d", s.YggAddr, s.cfg.DashPort),
	})

	// Check if lobby is full
	if occupied >= s.cfg.Slots {
		s.lobbyOnce.Do(func() { close(s.lobbyDone) })
	}
}

func (s *Server) handleLeave(seat string) {
	s.mu.Lock()
	delete(s.participants, seat)
	s.mu.Unlock()
	s.updateSelfMeta()
	_ = s.cfg.Room.OnParticipantLeave(seat)
}

func (s *Server) updateSelfMeta() {
	s.mu.RLock()
	occupied := len(s.participants)
	s.mu.RUnlock()

	meta := s.cfg.Room.GetRoomMeta()
	meta.Occupied = occupied
	meta.Waiting = occupied < s.cfg.Slots

	alias := fmt.Sprintf("%s [%d/%d", s.cfg.Name, occupied, s.cfg.Slots)
	if meta.Waiting {
		alias += " waiting"
	}
	alias += "]"

	s.peerServer.SetSelfMeta(SelfMeta{
		YggAddr:   s.YggAddr,
		PublicKey: s.Identity.PublicKey,
		Alias:     alias,
		Version:   "0.1.0",
	})
}

func (s *Server) logP2P(fromAddr, toAddr string, payload any) {
	from := "host"
	to := "host"
	if fromAddr != s.YggAddr {
		from = fromAddr[:min(8, len(fromAddr))] + "..."
	}
	if toAddr != s.YggAddr {
		to = toAddr[:min(8, len(toAddr))] + "..."
	}
	b, _ := json.Marshal(payload)
	summary := string(b)
	if len(summary) > 120 {
		summary = summary[:120]
	}
	var msgType string
	if m, ok := payload.(map[string]any); ok {
		if t, ok := m["type"].(string); ok {
			msgType = t
		}
	}
	s.BroadcastWS(map[string]any{
		"event": "p2p",
		"data": map[string]any{
			"from":    from,
			"to":      to,
			"type":    msgType,
			"summary": summary,
			"ts":      time.Now().UnixMilli(),
		},
	})
}

func jsonString(raw json.RawMessage) (string, bool) {
	if raw == nil {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}
