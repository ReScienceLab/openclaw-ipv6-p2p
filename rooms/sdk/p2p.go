package sdk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// Wire types — JSON field names must match the TypeScript implementation exactly.

type P2PMessage struct {
	FromYgg   string `json:"fromYgg"`
	PublicKey string `json:"publicKey"`
	Event     string `json:"event"`
	Content   string `json:"content"`
	Timestamp int64  `json:"timestamp"`
	Signature string `json:"signature"`
}

type PeerEntry struct {
	YggAddr   string `json:"yggAddr"`
	PublicKey string `json:"publicKey"`
	Alias     string `json:"alias,omitempty"`
	LastSeen  int64  `json:"lastSeen"`
}

type PeerAnnouncement struct {
	FromYgg   string      `json:"fromYgg"`
	PublicKey string      `json:"publicKey"`
	Alias     string      `json:"alias,omitempty"`
	Version   string      `json:"version,omitempty"`
	Timestamp int64       `json:"timestamp"`
	Signature string      `json:"signature"`
	Peers     []PeerEntry `json:"peers"`
}

type AnnounceMeta struct {
	Name    string
	Version string
}

// MessageHandler is called for each verified incoming P2P message.
type MessageHandler func(msg P2PMessage, verified bool)

// yggdrasilAddrRe matches 200::/7 addresses.
var yggdrasilAddrRe = regexp.MustCompile(`^2[0-9a-fA-F]{2}:`)

func isYggdrasilAddr(addr string) bool {
	// Strip IPv6-mapped IPv4 prefix
	if len(addr) > 7 && addr[:7] == "::ffff:" {
		addr = addr[7:]
	}
	return yggdrasilAddrRe.MatchString(addr)
}

// PeerDB is a minimal in-memory peer store used by the Room server.
type PeerDB struct {
	mu    sync.RWMutex
	peers map[string]PeerEntry // yggAddr → entry
	tofu  map[string]string    // yggAddr → publicKey (TOFU cache)
}

func newPeerDB() *PeerDB {
	return &PeerDB{
		peers: make(map[string]PeerEntry),
		tofu:  make(map[string]string),
	}
}

func (db *PeerDB) upsert(e PeerEntry) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if existing, ok := db.peers[e.YggAddr]; ok && e.LastSeen == 0 {
		e.LastSeen = existing.LastSeen
	}
	if e.LastSeen == 0 {
		e.LastSeen = time.Now().UnixMilli()
	}
	db.peers[e.YggAddr] = e
}

func (db *PeerDB) list(max int) []PeerEntry {
	db.mu.RLock()
	defer db.mu.RUnlock()
	result := make([]PeerEntry, 0, len(db.peers))
	for _, e := range db.peers {
		result = append(result, e)
		if len(result) >= max {
			break
		}
	}
	return result
}

func (db *PeerDB) tofuVerify(yggAddr, pubKey string) bool {
	db.mu.Lock()
	defer db.mu.Unlock()
	if existing, ok := db.tofu[yggAddr]; ok {
		return existing == pubKey
	}
	db.tofu[yggAddr] = pubKey
	return true
}

// PeerServer is the DeClaw HTTP peer server.
type PeerServer struct {
	identity *Identity
	db       *PeerDB
	testMode bool
	handlers []MessageHandler
	mu       sync.RWMutex
	selfMeta *SelfMeta
	server   *http.Server
}

// SelfMeta is the metadata announced to the network about this node.
type SelfMeta struct {
	YggAddr   string
	PublicKey string
	Alias     string
	Version   string
}

func newPeerServer(identity *Identity, testMode bool) *PeerServer {
	return &PeerServer{
		identity: identity,
		db:       newPeerDB(),
		testMode: testMode,
	}
}

func (ps *PeerServer) SetSelfMeta(m SelfMeta) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.selfMeta = &m
}

func (ps *PeerServer) OnMessage(h MessageHandler) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.handlers = append(ps.handlers, h)
}

func (ps *PeerServer) Start(port int) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /peer/ping", ps.handlePing)
	mux.HandleFunc("GET /peer/peers", ps.handlePeers)
	mux.HandleFunc("POST /peer/announce", ps.handleAnnounce)
	mux.HandleFunc("POST /peer/message", ps.handleMessage)

	ps.server = &http.Server{
		Addr:    fmt.Sprintf("[::]:%d", port),
		Handler: mux,
	}
	go func() {
		if err := ps.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[p2p] peer server error: %v", err)
		}
	}()
	log.Printf("[p2p] Peer server listening on [::]::%d (testMode=%v)", port, ps.testMode)
	return nil
}

func (ps *PeerServer) Stop(ctx context.Context) error {
	if ps.server != nil {
		return ps.server.Shutdown(ctx)
	}
	return nil
}

func (ps *PeerServer) handlePing(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"ok": true, "ts": time.Now().UnixMilli()})
}

func (ps *PeerServer) handlePeers(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"peers": ps.db.list(20)})
}

func (ps *PeerServer) handleAnnounce(w http.ResponseWriter, r *http.Request) {
	var ann PeerAnnouncement
	if err := json.NewDecoder(r.Body).Decode(&ann); err != nil {
		http.Error(w, "bad request", 400)
		return
	}

	srcIP := extractIP(r.RemoteAddr)
	if !ps.testMode {
		if !isYggdrasilAddr(srcIP) {
			http.Error(w, "source is not a Yggdrasil address", 403)
			return
		}
		if ann.FromYgg != srcIP {
			http.Error(w, fmt.Sprintf("fromYgg %s does not match TCP source %s", ann.FromYgg, srcIP), 403)
			return
		}
	}

	// Verify signature
	signable := map[string]any{
		"fromYgg":   ann.FromYgg,
		"publicKey": ann.PublicKey,
		"alias":     ann.Alias,
		"version":   ann.Version,
		"timestamp": ann.Timestamp,
		"peers":     ann.Peers,
	}
	if !VerifySignature(ann.PublicKey, signable, ann.Signature) {
		http.Error(w, "invalid signature", 403)
		return
	}

	ps.db.upsert(PeerEntry{YggAddr: ann.FromYgg, PublicKey: ann.PublicKey, Alias: ann.Alias, LastSeen: time.Now().UnixMilli()})
	for _, p := range ann.Peers {
		if p.YggAddr == ann.FromYgg {
			continue
		}
		ps.db.upsert(p)
	}

	ps.mu.RLock()
	self := ps.selfMeta
	ps.mu.RUnlock()

	resp := map[string]any{"ok": true, "peers": ps.db.list(20)}
	if self != nil {
		resp["self"] = map[string]any{
			"yggAddr":   self.YggAddr,
			"publicKey": self.PublicKey,
			"alias":     self.Alias,
			"version":   self.Version,
		}
	}
	writeJSON(w, resp)
}

func (ps *PeerServer) handleMessage(w http.ResponseWriter, r *http.Request) {
	var msg P2PMessage
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		http.Error(w, "bad request", 400)
		return
	}

	srcIP := extractIP(r.RemoteAddr)
	if !ps.testMode {
		if !isYggdrasilAddr(srcIP) {
			http.Error(w, "source is not a Yggdrasil address", 403)
			return
		}
		if msg.FromYgg != srcIP {
			http.Error(w, fmt.Sprintf("fromYgg mismatch: %s vs %s", msg.FromYgg, srcIP), 403)
			return
		}
	}

	// Verify Ed25519 signature (skipped in testMode)
	var verified bool
	if ps.testMode {
		verified = true
	} else {
		canonical := map[string]any{
			"fromYgg":   msg.FromYgg,
			"publicKey": msg.PublicKey,
			"event":     msg.Event,
			"content":   msg.Content,
			"timestamp": msg.Timestamp,
		}
		verified = VerifySignature(msg.PublicKey, canonical, msg.Signature)
	}

	// TOFU check
	if verified && !ps.db.tofuVerify(msg.FromYgg, msg.PublicKey) {
		http.Error(w, "public key mismatch (TOFU violation)", 403)
		return
	}

	ps.db.upsert(PeerEntry{YggAddr: msg.FromYgg, PublicKey: msg.PublicKey, LastSeen: time.Now().UnixMilli()})

	ps.mu.RLock()
	handlers := ps.handlers
	ps.mu.RUnlock()
	for _, h := range handlers {
		go h(msg, verified)
	}

	writeJSON(w, map[string]any{"ok": true})
}

// SendP2PMessage sends a signed DeClaw P2P message to a peer.
func SendP2PMessage(identity *Identity, toAddr, event, content string, port int) error {
	payload := map[string]any{
		"fromYgg":   identity.YggIpv6,
		"publicKey": identity.PublicKey,
		"event":     event,
		"content":   content,
		"timestamp": time.Now().UnixMilli(),
	}
	sig := SignMessage(identity, payload)
	payload["signature"] = sig

	body, _ := json.Marshal(payload)
	url := fmt.Sprintf("http://[%s]:%d/peer/message", toAddr, port)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("send to %s: %w", toAddr[:min(20, len(toAddr))], err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("send to %s: HTTP %d: %s", toAddr[:min(20, len(toAddr))], resp.StatusCode, b)
	}
	return nil
}

// AnnounceToNode sends a signed peer announcement and returns the peer list received.
func AnnounceToNode(identity *Identity, toAddr string, port int, meta AnnounceMeta, knownPeers []PeerEntry) ([]PeerEntry, *SelfMeta, error) {
	ann := PeerAnnouncement{
		FromYgg:   identity.YggIpv6,
		PublicKey: identity.PublicKey,
		Alias:     meta.Name,
		Version:   meta.Version,
		Timestamp: time.Now().UnixMilli(),
		Peers:     knownPeers,
	}
	signable := map[string]any{
		"fromYgg":   ann.FromYgg,
		"publicKey": ann.PublicKey,
		"alias":     ann.Alias,
		"version":   ann.Version,
		"timestamp": ann.Timestamp,
		"peers":     ann.Peers,
	}
	ann.Signature = SignMessage(identity, signable)

	body, _ := json.Marshal(ann)
	url := fmt.Sprintf("http://[%s]:%d/peer/announce", toAddr, port)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()

	var result struct {
		OK    bool        `json:"ok"`
		Self  *SelfMeta   `json:"self"`
		Peers []PeerEntry `json:"peers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, nil, err
	}
	return result.Peers, result.Self, nil
}

// DefaultBootstrapPeers are the hardcoded DeClaw bootstrap nodes.
var DefaultBootstrapPeers = []string{
	"200:697f:bda:1e8e:706a:6c5e:630b:51d",
	"200:e1a5:b063:958:8f74:ec45:8eb0:e30e",
	"200:9cf6:eaf1:7d3e:14b0:5869:2140:b618",
	"202:adbc:dde1:e272:1cdb:97d0:8756:4f77",
	"200:5ec6:62dd:9e91:3752:820c:98f5:5863",
}

// BootstrapDiscovery announces to all bootstrap nodes and returns the number of new peers found.
func BootstrapDiscovery(identity *Identity, db *PeerDB, port int, extra []string, meta AnnounceMeta) int {
	addrs := append([]string{}, DefaultBootstrapPeers...)
	addrs = append(addrs, extra...)

	type result struct {
		peers []PeerEntry
		self  *SelfMeta
	}
	ch := make(chan result, len(addrs))

	for _, addr := range addrs {
		go func(a string) {
			peers, self, err := AnnounceToNode(identity, a, port, meta, db.list(20))
			if err != nil {
				log.Printf("[p2p] bootstrap %s: %v", a[:min(20, len(a))], err)
				ch <- result{}
				return
			}
			ch <- result{peers, self}
		}(addr)
	}

	total := 0
	for range addrs {
		r := <-ch
		for _, p := range r.peers {
			if p.YggAddr == identity.YggIpv6 {
				continue
			}
			db.upsert(p)
			total++
		}
		if r.self != nil {
			db.upsert(PeerEntry{YggAddr: r.self.YggAddr, PublicKey: r.self.PublicKey, Alias: r.self.Alias})
		}
	}
	log.Printf("[p2p] Bootstrap complete — %d peers discovered", total)
	return total
}

func extractIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	// Strip IPv6-mapped IPv4 prefix
	if len(host) > 7 && host[:7] == "::ffff:" {
		return host[7:]
	}
	return host
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
