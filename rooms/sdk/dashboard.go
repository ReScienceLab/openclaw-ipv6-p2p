package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"golang.org/x/net/websocket"
)

// DashboardServer serves the WebSocket + static files dashboard.
type DashboardServer struct {
	port      int
	staticDir string
	server    *http.Server
	clients   sync.Map // *websocket.Conn → struct{}
	getState  func() any
}

func newDashboard(port int, staticDir string) *DashboardServer {
	return &DashboardServer{port: port, staticDir: staticDir}
}

// SetStateFunc registers a function that returns the full state
// snapshot sent to new WebSocket connections.
func (d *DashboardServer) SetStateFunc(fn func() any) {
	d.getState = fn
}

// Start begins serving HTTP + WebSocket on the configured port.
func (d *DashboardServer) Start() error {
	mux := http.NewServeMux()

	// WebSocket endpoint
	mux.Handle("/ws", websocket.Handler(d.handleWS))

	// Static files
	mux.Handle("/", http.FileServer(http.Dir(d.staticDir)))

	d.server = &http.Server{
		Addr:    fmt.Sprintf("[::]:%d", d.port),
		Handler: mux,
	}
	go func() {
		if err := d.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[dashboard] server error: %v", err)
		}
	}()
	log.Printf("[dashboard] Listening on [::]::%d  static=%s", d.port, d.staticDir)
	return nil
}

// Stop shuts down the HTTP server gracefully.
func (d *DashboardServer) Stop(ctx context.Context) error {
	if d.server != nil {
		return d.server.Shutdown(ctx)
	}
	return nil
}

// Broadcast sends a JSON event to all connected WebSocket clients.
func (d *DashboardServer) Broadcast(event any) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	d.clients.Range(func(k, _ any) bool {
		conn := k.(*websocket.Conn)
		if err := websocket.Message.Send(conn, string(data)); err != nil {
			d.clients.Delete(k)
		}
		return true
	})
}

func (d *DashboardServer) handleWS(conn *websocket.Conn) {
	d.clients.Store(conn, struct{}{})
	defer d.clients.Delete(conn)

	// Send initial state
	if d.getState != nil {
		initial := map[string]any{"event": "state", "data": d.getState()}
		if data, err := json.Marshal(initial); err == nil {
			_ = websocket.Message.Send(conn, string(data))
		}
	}

	// Keep connection alive until client disconnects
	var msg string
	for {
		if err := websocket.Message.Receive(conn, &msg); err != nil {
			break
		}
	}
}
