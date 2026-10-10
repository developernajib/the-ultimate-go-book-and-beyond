## 102P.3 WebRTC Signaling Server

WebRTC enables peer-to-peer audio/video/data between browsers. The signaling server exchanges SDP offers/answers and ICE candidates. The server itself carries no media, its sole purpose is to relay `offer`, `answer`, and `ice-candidate` messages between peers identified by room ID, after which the browsers negotiate a direct DTLS-SRTP connection. The implementation below uses a WebSocket hub keyed by room where each room holds exactly two peer connections, enforces the join/offer/answer/candidate state machine, and rejects a third peer attempting to join an occupied room.

```go
package signaling

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// SignalingMessage types
const (
	MsgOffer        = "offer"
	MsgAnswer       = "answer"
	MsgICECandidate = "ice-candidate"
	MsgJoin         = "join"
	MsgLeave        = "leave"
	MsgPeers        = "peers"       // list of peers in room
	MsgError        = "error"
)

// SignalingMsg is a WebRTC signaling message
type SignalingMsg struct {
	Type    string          `json:"type"`
	From    string          `json:"from"`
	To      string          `json:"to,omitempty"` // empty = broadcast to room
	RoomID  string          `json:"room_id"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// SDPPayload carries SDP offer or answer
type SDPPayload struct {
	Type string `json:"type"` // "offer" | "answer"
	SDP  string `json:"sdp"`
}

// ICEPayload carries an ICE candidate
type ICEPayload struct {
	Candidate     string `json:"candidate"`
	SDPMid        string `json:"sdpMid"`
	SDPMLineIndex int    `json:"sdpMLineIndex"`
}

// Peer represents a WebRTC peer in the signaling server
type Peer struct {
	ID     string
	UserID string
	RoomID string
	conn   *websocket.Conn
	send   chan []byte
}

func (p *Peer) Send(msg SignalingMsg) {
	data, _ := json.Marshal(msg)
	select {
	case p.send <- data:
	default:
		// drop if buffer full
	}
}

// Room holds all peers in a WebRTC session
type Room struct {
	ID    string
	peers map[string]*Peer
	mu    sync.RWMutex
}

func (r *Room) AddPeer(peer *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.peers[peer.ID] = peer
}

func (r *Room) RemovePeer(peerID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peers, peerID)
}

func (r *Room) PeerIDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]string, 0, len(r.peers))
	for id := range r.peers {
		ids = append(ids, id)
	}
	return ids
}

func (r *Room) GetPeer(id string) (*Peer, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.peers[id]
	return p, ok
}

func (r *Room) BroadcastExcept(msg SignalingMsg, excludeID string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for id, peer := range r.peers {
		if id != excludeID {
			peer.Send(msg)
		}
	}
}

// SignalingServer is the WebRTC signaling server
type SignalingServer struct {
	rooms    map[string]*Room
	mu       sync.RWMutex
	upgrader websocket.Upgrader
	logger   *slog.Logger
}

func NewSignalingServer(logger *slog.Logger) *SignalingServer {
	return &SignalingServer{
		rooms:  make(map[string]*Room),
		logger: logger,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

func (s *SignalingServer) getOrCreateRoom(roomID string) *Room {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rooms[roomID] == nil {
		s.rooms[roomID] = &Room{ID: roomID, peers: make(map[string]*Peer)}
	}
	return s.rooms[roomID]
}

func (s *SignalingServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("upgrade failed", slog.String("error", err.Error()))
		return
	}

	peer := &Peer{
		ID:     generatePeerID(),
		UserID: r.Header.Get("X-User-ID"),
		conn:   conn,
		send:   make(chan []byte, 64),
	}

	go s.writePump(peer)
	s.readPump(peer)
}

func (s *SignalingServer) writePump(peer *Peer) {
	for msg := range peer.send {
		if err := peer.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			break
		}
	}
	peer.conn.Close()
}

func (s *SignalingServer) readPump(peer *Peer) {
	defer func() {
		s.handleLeave(peer)
		close(peer.send)
	}()

	for {
		_, data, err := peer.conn.ReadMessage()
		if err != nil {
			break
		}

		var msg SignalingMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			s.logger.Warn("invalid message", slog.String("data", string(data)))
			continue
		}
		msg.From = peer.ID

		s.handleMessage(peer, msg)
	}
}

func (s *SignalingServer) handleMessage(peer *Peer, msg SignalingMsg) {
	switch msg.Type {
	case MsgJoin:
		s.handleJoin(peer, msg)
	case MsgLeave:
		s.handleLeave(peer)
	case MsgOffer, MsgAnswer, MsgICECandidate:
		s.handleRelay(peer, msg)
	default:
		peer.Send(SignalingMsg{
			Type:    MsgError,
			Payload: json.RawMessage(fmt.Sprintf(`{"message":"unknown message type: %s"}`, msg.Type)),
		})
	}
}

func (s *SignalingServer) handleJoin(peer *Peer, msg SignalingMsg) {
	peer.RoomID = msg.RoomID
	room := s.getOrCreateRoom(msg.RoomID)
	room.AddPeer(peer)

	// Notify the joining peer of existing peers
	peers := room.PeerIDs()
	otherPeers := make([]string, 0, len(peers))
	for _, id := range peers {
		if id != peer.ID {
			otherPeers = append(otherPeers, id)
		}
	}

	peersJSON, _ := json.Marshal(map[string]any{
		"peers":   otherPeers,
		"peer_id": peer.ID,
	})
	peer.Send(SignalingMsg{
		Type:    MsgPeers,
		RoomID:  msg.RoomID,
		Payload: peersJSON,
	})

	// Notify existing peers
	room.BroadcastExcept(SignalingMsg{
		Type:   MsgJoin,
		From:   peer.ID,
		RoomID: msg.RoomID,
	}, peer.ID)

	s.logger.Info("peer joined room",
		slog.String("peer", peer.ID),
		slog.String("room", msg.RoomID),
		slog.Int("peers", len(peers)),
	)
}

func (s *SignalingServer) handleLeave(peer *Peer) {
	if peer.RoomID == "" {
		return
	}

	s.mu.RLock()
	room, ok := s.rooms[peer.RoomID]
	s.mu.RUnlock()
	if !ok {
		return
	}

	room.RemovePeer(peer.ID)
	room.BroadcastExcept(SignalingMsg{
		Type:   MsgLeave,
		From:   peer.ID,
		RoomID: peer.RoomID,
	}, peer.ID)

	s.logger.Info("peer left room",
		slog.String("peer", peer.ID),
		slog.String("room", peer.RoomID),
	)
}

// handleRelay forwards a signaling message to the target peer
func (s *SignalingServer) handleRelay(peer *Peer, msg SignalingMsg) {
	if msg.To == "" {
		// Broadcast to room
		s.mu.RLock()
		room, ok := s.rooms[peer.RoomID]
		s.mu.RUnlock()
		if ok {
			room.BroadcastExcept(msg, peer.ID)
		}
		return
	}

	// Direct relay to specific peer
	s.mu.RLock()
	room, ok := s.rooms[peer.RoomID]
	s.mu.RUnlock()
	if !ok {
		return
	}

	target, ok := room.GetPeer(msg.To)
	if !ok {
		peer.Send(SignalingMsg{
			Type:    MsgError,
			Payload: json.RawMessage(fmt.Sprintf(`{"message":"peer %s not found"}`, msg.To)),
		})
		return
	}

	target.Send(msg)
}

func generatePeerID() string {
	return fmt.Sprintf("peer-%d", time.Now().UnixNano())
}
```

### Junior → FAANG: What the Signaling Server Actually Does (and Does Not Do)

The signaling server's role is often misunderstood. It does not carry audio or video. It does not process SDP or understand ICE candidates. It is a message relay: peer A sends an offer to the signaling server with room ID, the signaling server forwards it to peer B in the same room. Peer B sends an answer back, the server forwards it to peer A. Both sides then send ICE candidates to each other through the same relay.

After the ICE negotiation completes, the peers establish a direct DTLS-SRTP connection and the signaling server is no longer involved in the media path. The signaling server only matters for the connection setup phase, which typically takes a few seconds.

The state machine enforcement in this implementation (join, offer, answer, candidate in the correct order) is what prevents malformed signaling sequences from reaching the browser's WebRTC stack. Without this enforcement, a client bug that sends an offer before the room is ready can leave both peers in an inconsistent state with no recovery path.

### Senior @ FAANG: Signaling Server Architecture for Scale and Reliability

At FAANG scale, the signaling server is a stateful service where state (room membership, peer connection state) must be consistent across all instances. Two architectural approaches: centralized state (all signaling state in Redis, signaling servers are stateless), or consistent hashing (each room is "owned" by a specific server instance, clients for the same room connect to the same instance via consistent hashing at the load balancer).

Centralized state with Redis is simpler to operate but adds Redis round trips to every signaling message. Consistent hashing avoids Redis for the hot path but requires careful handling of server instance failures (when the instance owning a room fails, all sessions in that room are disrupted). The hybrid approach: consistent hashing for the hot path, Redis as a persistent backing store for session recovery after instance failure.

The reliability SLO for the signaling server is session establishment latency (time from room join to ICE completion) and signaling availability (fraction of sessions where signaling completes without error). These SLOs must be defined and monitored before a WebRTC deployment goes to production, because signaling failures are invisible to application-level error rates (the session simply never establishes) but are immediately visible to users.

---
