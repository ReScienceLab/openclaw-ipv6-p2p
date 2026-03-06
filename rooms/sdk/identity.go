// Package sdk provides the DeClaw Rooms framework — a generic multi-agent
// collaboration platform over Yggdrasil IPv6 P2P.
package sdk

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Identity holds the Ed25519 keypair and derived IPv6 addresses.
// JSON layout is wire-compatible with the TypeScript identity.json.
type Identity struct {
	AgentID    string `json:"agentId"`
	PublicKey  string `json:"publicKey"`  // base64 Ed25519 public key (32 bytes)
	PrivateKey string `json:"privateKey"` // base64 Ed25519 private key (32 bytes seed)
	CgaIpv6    string `json:"cgaIpv6"`
	YggIpv6    string `json:"yggIpv6"`
}

// pubBytes returns the raw 32-byte public key.
func (id *Identity) pubBytes() []byte {
	b, _ := base64.StdEncoding.DecodeString(id.PublicKey)
	return b
}

// privBytes returns the raw 32-byte private key seed.
func (id *Identity) privBytes() []byte {
	b, _ := base64.StdEncoding.DecodeString(id.PrivateKey)
	return b
}

// ed25519PrivKey returns the full 64-byte ed25519 private key (seed+pub).
func (id *Identity) ed25519PrivKey() ed25519.PrivateKey {
	seed := id.privBytes()
	return ed25519.NewKeyFromSeed(seed)
}

// LoadOrCreateIdentity loads identity.json from dataDir, or generates a new one.
func LoadOrCreateIdentity(dataDir string) (*Identity, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dataDir, "identity.json")
	if data, err := os.ReadFile(path); err == nil {
		var id Identity
		if err := json.Unmarshal(data, &id); err == nil {
			return &id, nil
		}
	}
	id, err := generateIdentity()
	if err != nil {
		return nil, err
	}
	data, _ := json.MarshalIndent(id, "", "  ")
	if err := os.WriteFile(path, data, 0600); err != nil {
		return nil, err
	}
	return id, nil
}

func generateIdentity() (*Identity, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	seed := priv.Seed() // 32-byte seed
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	privB64 := base64.StdEncoding.EncodeToString(seed)

	h := sha256.Sum256(pub)
	agentID := fmt.Sprintf("%x", h[:8]) // 16 hex chars

	return &Identity{
		AgentID:    agentID,
		PublicKey:  pubB64,
		PrivateKey: privB64,
		CgaIpv6:    deriveCgaIpv6(pub),
		YggIpv6:    DeriveYggIpv6(pub),
	}, nil
}

// DeriveYggIpv6 derives a Yggdrasil-compatible 200::/7 address from a public key.
// Uses SHA-512, matching the TypeScript implementation exactly.
func DeriveYggIpv6(pubKey []byte) string {
	h := sha512.Sum512(pubKey)
	addr := make([]byte, 16)
	addr[0] = 0x02
	copy(addr[1:], h[:15])
	return ipv6String(addr)
}

// deriveCgaIpv6 derives a CGA ULA fd00::/8 address from a public key.
func deriveCgaIpv6(pubKey []byte) string {
	prefix := []byte{0xfd, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x00}
	h := sha256.Sum256(pubKey)
	addr := make([]byte, 16)
	copy(addr[:8], prefix)
	copy(addr[8:], h[24:32])
	return ipv6String(addr)
}

func ipv6String(b []byte) string {
	parts := make([]string, 8)
	for i := 0; i < 8; i++ {
		parts[i] = fmt.Sprintf("%x", binary.BigEndian.Uint16(b[i*2:i*2+2]))
	}
	result := ""
	for i, p := range parts {
		if i > 0 {
			result += ":"
		}
		result += p
	}
	return result
}

// SignMessage signs a canonical JSON payload with the identity's private key.
// Returns a base64-encoded Ed25519 signature.
func SignMessage(id *Identity, payload map[string]any) string {
	canonical := canonicalJSON(payload)
	sig := ed25519.Sign(id.ed25519PrivKey(), canonical)
	return base64.StdEncoding.EncodeToString(sig)
}

// VerifySignature verifies an Ed25519 signature over a canonical JSON payload.
func VerifySignature(pubKeyB64 string, payload map[string]any, sigB64 string) bool {
	pubKey, err := base64.StdEncoding.DecodeString(pubKeyB64)
	if err != nil {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return false
	}
	canonical := canonicalJSON(payload)
	return ed25519.Verify(pubKey, canonical, sig)
}

// canonicalJSON produces a deterministic JSON encoding (sorted keys) matching
// the TypeScript canonicalJSON implementation.
func canonicalJSON(v map[string]any) []byte {
	b, _ := json.Marshal(v)
	return b
}
