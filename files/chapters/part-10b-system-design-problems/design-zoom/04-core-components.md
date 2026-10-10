## Core Components

### 1. Signaling Service

The Signaling Service handles WebRTC session negotiation, which is the control-plane handshake that occurs before any audio or video flows. When a participant joins a meeting, the signaling server assigns them to a Media Server (SFU), then relays their SDP offer and ICE candidates to other participants via WebSocket messages. The server maintains the mapping of participant WebSocket connections in a `sync.RWMutex`-protected map and stores the current meeting roster in Redis so that multiple signaling server instances can serve the same meeting.

Two details in this code matter more than the plumbing. First, the join path authenticates the caller and authorizes them against the specific meeting before the WebSocket upgrade. Trusting a client-supplied user ID header, or accepting anyone who knows a nine-digit meeting ID, is precisely the gap that produced the "Zoombombing" incidents of 2020, when uninvited users walked into meetings whose IDs had been shared publicly. Second, every write to a participant's WebSocket goes through the single `writePump` goroutine that owns the connection. `gorilla/websocket` permits only one concurrent writer per connection, so a second goroutine calling `WriteMessage` directly would corrupt the frame stream.

```go
package signaling

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// SignalingService handles WebRTC session negotiation
type SignalingService struct {
	meetings  map[string]*MeetingRoom
	mu        sync.RWMutex
	rdb       *redis.Client
	mediaCtrl MediaController
	tokens    TokenVerifier
	dir       MeetingDirectory
	upgrader  websocket.Upgrader
}

// MediaController is the signaling service's view of an SFU. Keeping the
// interface here, on the consumer side, lets the SFU be a local process, a
// gRPC peer, or a test double without changing this package.
type MediaController interface {
	AddParticipant(serverAddr, meetingID, userID string) error
	RemoveParticipant(serverAddr, meetingID, userID string) error
	SendSignal(serverAddr, meetingID string, msg SignalingMessage) error
	StartScreenShare(serverAddr, meetingID, userID string) error
}

// TokenVerifier validates the signed join token the client presents and
// returns the user ID it was issued to.
type TokenVerifier interface {
	Verify(ctx context.Context, token string) (userID string, err error)
}

// MeetingDirectory answers the only question signaling needs from the
// Meeting Service: may this user join this meeting, and where is its SFU.
type MeetingDirectory interface {
	Authorize(ctx context.Context, meetingID, userID, passCode string) (MeetingAuth, error)
}

// MeetingAuth is the outcome of a successful authorization check.
type MeetingAuth struct {
	HostID          string
	MediaServerAddr string
	Settings        MeetingSettings
}

// MeetingRoom tracks participants and their SDP/ICE state. Its mutex guards
// Participants, HostID, and the mutable fields of every *Participant in it.
type MeetingRoom struct {
	ID              string
	HostID          string
	Participants    map[string]*Participant
	MediaServerAddr string // IP of assigned SFU
	Settings        MeetingSettings
	mu              sync.RWMutex
	CreatedAt       time.Time
}

// Participant represents one person in a meeting. AudioMuted, VideoMuted,
// and IsHost are guarded by the owning MeetingRoom's mutex: the roster
// builder reads them from one goroutine while another participant's read
// pump writes them.
type Participant struct {
	UserID      string
	DisplayName string
	conn        *websocket.Conn
	send        chan []byte
	done        chan struct{}
	closeOnce   sync.Once
	AudioMuted  bool
	VideoMuted  bool
	IsHost      bool
	IsCoHost    bool
	JoinedAt    time.Time
}

// close tears the participant down exactly once. Closing done unblocks
// writePump, which would otherwise leak for the life of the process
// because nothing else ever closes the send channel.
func (p *Participant) close() {
	p.closeOnce.Do(func() {
		close(p.done)
		p.conn.Close()
	})
}

// SignalingMessage is the wire format for signaling
type SignalingMessage struct {
	Type    string          `json:"type"`
	From    string          `json:"from"`
	To      string          `json:"to,omitempty"` // empty = broadcast
	Payload json.RawMessage `json:"payload"`
}

// Message types
const (
	MsgOffer        = "offer"         // SDP offer
	MsgAnswer       = "answer"        // SDP answer
	MsgICECandidate = "ice_candidate" // ICE candidate
	MsgJoin         = "join"
	MsgLeave        = "leave"
	MsgMuteAudio    = "mute_audio"
	MsgMuteVideo    = "mute_video"
	MsgScreenShare  = "screen_share"
	MsgRoster       = "roster" // current participant list
	MsgHostChange   = "host_change"
	MsgWaitingRoom  = "waiting_room"
	MsgAdmit        = "admit"
)

// JoinMeeting handles a participant joining
func (s *SignalingService) JoinMeeting(w http.ResponseWriter, r *http.Request) {
	meetingID := r.PathValue("meeting_id")

	// Authenticate first, and never from a client-supplied header: an
	// "X-User-ID" header lets any caller claim any identity. The user ID
	// must come from a token the server itself signed.
	userID, err := s.tokens.Verify(r.Context(), bearerToken(r))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Then authorize against this specific meeting. Authentication alone
	// only proves who is calling. Without a per-meeting check, any logged-in
	// user who guesses or is forwarded a meeting ID walks straight in.
	auth, err := s.dir.Authorize(r.Context(), meetingID, userID, r.URL.Query().Get("passcode"))
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	participant := &Participant{
		UserID:      userID,
		DisplayName: sanitizeName(r.URL.Query().Get("name")),
		conn:        conn,
		send:        make(chan []byte, 64),
		done:        make(chan struct{}),
		// Host status is derived from the authorization result, not from
		// anything the client sent, and it has to be set here: code below
		// gates the waiting room and the admit control on it.
		IsHost:   userID == auth.HostID,
		IsCoHost: slices.Contains(auth.Settings.CoHostIDs, userID),
		JoinedAt: time.Now(),
	}
	defer participant.close()

	room := s.getOrCreateRoom(meetingID, auth)

	// Waiting room: park non-hosts until the host admits them.
	if room.Settings.WaitingRoomEnabled && !participant.IsHost {
		if !s.waitForAdmission(r.Context(), participant, room) {
			return
		}
	}

	s.addParticipant(room, participant)
	defer s.removeParticipant(room, participant)

	go participant.writePump()
	s.readPump(participant, room)
}

// bearerToken pulls the token out of the Authorization header, falling back
// to a query parameter because browser WebSocket clients cannot set headers.
func bearerToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return r.URL.Query().Get("token")
}

// sanitizeName bounds a display name. It is echoed to every other
// participant, so it is untrusted input on someone else's screen.
func sanitizeName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	if len(name) > 64 {
		name = name[:64]
	}
	if name == "" {
		name = "Guest"
	}
	return name
}

// getOrCreateRoom returns the local room object for a meeting. The room is
// created from the authorization result rather than from client input, so a
// caller cannot conjure a room with itself as host.
func (s *SignalingService) getOrCreateRoom(meetingID string, auth MeetingAuth) *MeetingRoom {
	s.mu.Lock()
	defer s.mu.Unlock()

	if room, ok := s.meetings[meetingID]; ok {
		return room
	}
	room := &MeetingRoom{
		ID:              meetingID,
		HostID:          auth.HostID,
		Participants:    make(map[string]*Participant),
		MediaServerAddr: auth.MediaServerAddr,
		Settings:        auth.Settings,
		CreatedAt:       time.Now(),
	}
	s.meetings[meetingID] = room
	return room
}

// cleanupRoom drops an empty room. It rechecks emptiness under the lock
// because a participant can rejoin between the caller's check and this one.
func (s *SignalingService) cleanupRoom(meetingID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	room, ok := s.meetings[meetingID]
	if !ok {
		return
	}
	room.mu.RLock()
	empty := len(room.Participants) == 0
	room.mu.RUnlock()
	if empty {
		delete(s.meetings, meetingID)
	}
}

func (s *SignalingService) readPump(p *Participant, room *MeetingRoom) {
	defer p.close()

	// Cap the frame size: SDP offers are a few kilobytes, and without a
	// limit a client can make the server allocate whatever it sends.
	p.conn.SetReadLimit(maxMessageBytes)
	p.conn.SetReadDeadline(time.Now().Add(pongWait))
	p.conn.SetPongHandler(func(string) error {
		return p.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, data, err := p.conn.ReadMessage()
		if err != nil {
			break
		}

		var msg SignalingMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		msg.From = p.UserID

		s.handleMessage(room, p, msg)
	}
}

func (s *SignalingService) handleMessage(room *MeetingRoom, sender *Participant, msg SignalingMessage) {
	switch msg.Type {
	case MsgOffer, MsgAnswer, MsgICECandidate:
		// WebRTC signaling - relay to specific participant or to SFU
		if msg.To != "" {
			s.relayTo(room, msg.To, msg)
		} else {
			// Relay to SFU for server-side processing
			s.mediaCtrl.SendSignal(room.MediaServerAddr, room.ID, msg)
		}

	case MsgMuteAudio:
		// buildRoster reads this field from whichever goroutine is running
		// another participant's join, so the write needs the room lock.
		room.mu.Lock()
		sender.AudioMuted = true
		room.mu.Unlock()
		s.broadcastToRoom(room, msg, sender.UserID)

	case MsgMuteVideo:
		room.mu.Lock()
		sender.VideoMuted = true
		room.mu.Unlock()
		s.broadcastToRoom(room, msg, sender.UserID)

	case MsgScreenShare:
		// Notify SFU to handle screen share stream
		s.mediaCtrl.StartScreenShare(room.MediaServerAddr, room.ID, sender.UserID)
		s.broadcastToRoom(room, msg, sender.UserID)

	case MsgAdmit:
		// Host admitting someone from the waiting room. Read IsHost under
		// the room lock: migrateHost writes it from another goroutine.
		room.mu.RLock()
		isHost := sender.IsHost
		room.mu.RUnlock()
		if !isHost {
			return
		}
		var payload struct {
			UserID string `json:"user_id"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			return
		}
		s.admitFromWaitingRoom(room, payload.UserID)
	}
}

func (s *SignalingService) addParticipant(room *MeetingRoom, p *Participant) {
	room.mu.Lock()
	room.Participants[p.UserID] = p
	room.mu.Unlock()

	// Send current roster to new participant
	roster := s.buildRoster(room)
	s.sendToParticipant(p, SignalingMessage{
		Type:    MsgRoster,
		Payload: roster,
	})

	// Notify others of new participant
	s.broadcastToRoom(room, SignalingMessage{
		Type:    MsgJoin,
		From:    p.UserID,
		Payload: mustMarshal(map[string]string{"display_name": p.DisplayName}),
	}, p.UserID)

	// Notify SFU to add participant to media session
	s.mediaCtrl.AddParticipant(room.MediaServerAddr, room.ID, p.UserID)
}

func (s *SignalingService) removeParticipant(room *MeetingRoom, p *Participant) {
	room.mu.Lock()
	delete(room.Participants, p.UserID)
	remaining := len(room.Participants)
	wasHost := p.IsHost
	room.mu.Unlock()

	p.close()

	s.broadcastToRoom(room, SignalingMessage{
		Type: MsgLeave,
		From: p.UserID,
	}, "")

	s.mediaCtrl.RemoveParticipant(room.MediaServerAddr, room.ID, p.UserID)

	// Host migration if host left
	if wasHost && remaining > 0 {
		s.migrateHost(room)
	}

	// Clean up empty rooms
	if remaining == 0 {
		s.cleanupRoom(room.ID)
	}
}

func (s *SignalingService) relayTo(room *MeetingRoom, toUserID string, msg SignalingMessage) {
	room.mu.RLock()
	target, ok := room.Participants[toUserID]
	room.mu.RUnlock()

	if !ok {
		return
	}

	s.sendToParticipant(target, msg)
}

func (s *SignalingService) broadcastToRoom(room *MeetingRoom, msg SignalingMessage, excludeUserID string) {
	data, _ := json.Marshal(msg)

	room.mu.RLock()
	defer room.mu.RUnlock()

	for uid, p := range room.Participants {
		if uid != excludeUserID {
			select {
			case p.send <- data:
			default:
				// Drop - participant too slow
			}
		}
	}
}

func (s *SignalingService) migrateHost(room *MeetingRoom) {
	room.mu.Lock()
	defer room.mu.Unlock()

	// Prefer a co-host the host designated. Fall back to the
	// longest-connected participant only if there is none.
	var newHost *Participant
	for _, p := range room.Participants {
		if !p.IsCoHost {
			continue
		}
		if newHost == nil || p.JoinedAt.Before(newHost.JoinedAt) {
			newHost = p
		}
	}
	if newHost == nil {
		for _, p := range room.Participants {
			if newHost == nil || p.JoinedAt.Before(newHost.JoinedAt) {
				newHost = p
			}
		}
	}

	if newHost != nil {
		newHost.IsHost = true
		room.HostID = newHost.UserID
		data, _ := json.Marshal(SignalingMessage{
			Type:    MsgHostChange,
			Payload: mustMarshal(map[string]string{"new_host": newHost.UserID}),
		})
		for _, p := range room.Participants {
			select {
			case p.send <- data:
			default:
			}
		}
	}
}

// waitForAdmission parks a participant until the host admits them, and
// reports whether they were admitted. The admit signal arrives over Redis
// Pub/Sub because the host may be attached to a different signaling
// instance than the waiting participant.
//
// Order matters: subscribe before announcing the participant to the host,
// otherwise a host who admits instantly publishes into a channel nobody is
// listening on yet and the participant waits out the full timeout.
func (s *SignalingService) waitForAdmission(ctx context.Context, p *Participant, room *MeetingRoom) bool {
	pubsub := s.rdb.Subscribe(ctx, fmt.Sprintf("admit:%s:%s", room.ID, p.UserID))
	defer pubsub.Close()

	waitKey := fmt.Sprintf("waiting:%s", room.ID)
	s.rdb.SAdd(ctx, waitKey, p.UserID)
	s.rdb.Expire(ctx, waitKey, 2*time.Hour)

	// Notify host
	room.mu.RLock()
	host, ok := room.Participants[room.HostID]
	room.mu.RUnlock()

	if ok {
		s.sendToParticipant(host, SignalingMessage{
			Type:    MsgWaitingRoom,
			Payload: mustMarshal(map[string]string{"user_id": p.UserID, "display_name": p.DisplayName}),
		})
	}

	select {
	case <-pubsub.Channel():
		return true
	case <-time.After(waitingRoomTimeout):
		s.rdb.SRem(ctx, waitKey, p.UserID)
		return false
	case <-ctx.Done():
		s.rdb.SRem(ctx, waitKey, p.UserID)
		return false
	}
}

const waitingRoomTimeout = 10 * time.Minute

func (s *SignalingService) admitFromWaitingRoom(room *MeetingRoom, userID string) {
	waitKey := fmt.Sprintf("waiting:%s", room.ID)
	s.rdb.SRem(context.Background(), waitKey, userID)
	// Signal the waiting connection to proceed (via Redis Pub/Sub)
	s.rdb.Publish(context.Background(), fmt.Sprintf("admit:%s:%s", room.ID, userID), "admit")
}

func (s *SignalingService) buildRoster(room *MeetingRoom) json.RawMessage {
	room.mu.RLock()
	defer room.mu.RUnlock()

	roster := make([]map[string]any, 0, len(room.Participants))
	for _, p := range room.Participants {
		roster = append(roster, map[string]any{
			"user_id":      p.UserID,
			"display_name": p.DisplayName,
			"is_host":      p.IsHost,
			"audio_muted":  p.AudioMuted,
			"video_muted":  p.VideoMuted,
		})
	}
	data, _ := json.Marshal(roster)
	return data
}

func (s *SignalingService) sendToParticipant(p *Participant, msg SignalingMessage) {
	data, _ := json.Marshal(msg)
	select {
	case p.send <- data:
	default:
	}
}

// writePump is the sole writer for this connection. gorilla/websocket
// allows one concurrent writer at a time, so every other goroutine hands
// bytes to the send channel instead of touching the connection.
//
// It exits on done rather than ranging over send, which nothing closes: a
// plain range would park this goroutine forever after the participant left.
func (p *Participant) writePump() {
	defer p.conn.Close()

	ping := time.NewTicker(pingInterval)
	defer ping.Stop()

	for {
		select {
		case msg := <-p.send:
			p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ping.C:
			// Detect participants whose network vanished without a close
			// frame, which is the normal case on mobile.
			p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-p.done:
			return
		}
	}
}

const (
	writeWait       = 10 * time.Second
	pingInterval    = 30 * time.Second
	pongWait        = 90 * time.Second // must exceed pingInterval
	maxMessageBytes = 64 << 10
)

type MeetingSettings struct {
	WaitingRoomEnabled bool
	MaxParticipants    int
	MuteOnEntry        bool
	RecordingEnabled   bool
	E2EEncryption      bool
	// CoHostIDs are the users the host promoted. They inherit host
	// controls and are first in line for host migration.
	CoHostIDs []string
}

func mustMarshal(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}
```

### 2. Media Server (SFU)

A Selective Forwarding Unit (SFU) is the core media architecture decision that separates modern video conferencing from older MCU (Multipoint Control Unit) designs. Instead of decoding and re-encoding every participant's stream into a single mixed stream (MCU style), the SFU receives one stream per publisher and forwards it selectively to each subscriber, choosing the appropriate simulcast quality layer based on that subscriber's available bandwidth. This avoids CPU-intensive transcoding while still giving each participant a stream quality matched to their network conditions.

```go
package sfu

import (
	"context"
	"fmt"
	"sync"
)

// SFU (Selective Forwarding Unit) routes media streams efficiently
// Unlike MCU (Multipoint Control Unit): no transcoding → lower latency
// SFU receives one stream per publisher and forwards to all subscribers
// Simulcast: publisher sends 3 quality levels - SFU selects per subscriber

// MediaSession manages one meeting's media
type MediaSession struct {
	MeetingID   string
	Publishers  map[string]*Publisher  // userID → publisher (sender)
	Subscribers map[string]*Subscriber // userID → subscriber (receiver)
	mu          sync.RWMutex
}

// Publisher represents a participant who is sending media. The DTLS-SRTP
// keys for its encrypted media live with the transport, not here.
type Publisher struct {
	UserID string
	Tracks []*Track // video (3 simulcast layers) + audio
}

// Track is a single media stream (audio or video)
type Track struct {
	ID      string
	Kind    string // "audio", "video"
	Quality string // "low", "medium", "high" (simulcast)
	Bitrate int    // current bitrate
	SSRC    uint32 // RTP Synchronization Source
}

// Subscriber represents a participant receiving media
type Subscriber struct {
	UserID         string
	SubscribedTo   map[string]*SubscriptionState // publisherID → subscription
	NetworkQuality float64                       // 0-1, updated by RTCP feedback
	MaxBitrate     int                           // bandwidth cap
}

// SubscriptionState tracks which quality layer is being served
type SubscriptionState struct {
	ActiveLayer string // low/medium/high
	RequestedBy string // "auto" or userID
}

// SelectLayer decides which simulcast layer to forward to a subscriber
// Based on subscriber's available bandwidth and network quality
func (s *MediaSession) SelectLayer(subscriberID string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	sub, ok := s.Subscribers[subscriberID]
	if !ok {
		return "low"
	}
	return selectLayer(sub)
}

// selectLayer holds no lock of its own. Callers that already hold s.mu use
// it directly: sync.RWMutex is not reentrant, so a helper that re-acquired
// the lock would deadlock the moment a lock holder called it.
func selectLayer(sub *Subscriber) string {
	// Adaptive bitrate: choose layer that fits within subscriber's bandwidth
	switch {
	case sub.MaxBitrate >= 1500_000 && sub.NetworkQuality > 0.8:
		return "high"
	case sub.MaxBitrate >= 500_000 && sub.NetworkQuality > 0.5:
		return "medium"
	default:
		return "low"
	}
}

// UpdateNetworkQuality processes RTCP feedback to update subscriber quality estimate
func (s *MediaSession) UpdateNetworkQuality(subscriberID string, packetLossRate float64, jitterMs float64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sub, ok := s.Subscribers[subscriberID]
	if !ok {
		return
	}

	// Quality score: 1.0 = perfect, 0.0 = terrible
	lossScore := 1.0 - packetLossRate
	jitterScore := 1.0 - (jitterMs / 100.0) // 100ms = 0 quality
	if jitterScore < 0 {
		jitterScore = 0
	}

	newQuality := (lossScore + jitterScore) / 2
	// Smooth with exponential moving average
	sub.NetworkQuality = 0.7*sub.NetworkQuality + 0.3*newQuality

	// Adjust layer if needed. This runs under s.mu, so it calls the
	// lock-free helper rather than the exported SelectLayer.
	newLayer := selectLayer(sub)
	for _, state := range sub.SubscribedTo {
		if state.ActiveLayer != newLayer {
			state.ActiveLayer = newLayer
			// In production: send a PLI (Picture Loss Indication) to the
			// publisher for the layer being switched to. The publisher is
			// already sending every layer under simulcast, so nothing is
			// re-encoded. The SFU only needs a fresh keyframe on the new
			// layer, since a subscriber that starts mid-GOP has nothing to
			// decode against and would show a frozen or garbled picture.
		}
	}
}

// BreakoutRoom splits a meeting into smaller subgroups
type BreakoutRoomManager struct {
	MeetingID string
	Rooms     map[string]*BreakoutRoom
	mu        sync.RWMutex
}

// BreakoutRoom is a sub-meeting within a meeting
type BreakoutRoom struct {
	ID           string
	Name         string
	Participants []string
	MediaSession *MediaSession
}

// CreateBreakoutRooms splits participants into N rooms
func (m *BreakoutRoomManager) CreateBreakoutRooms(ctx context.Context, participants []string, numRooms int) error {
	if numRooms <= 0 {
		return fmt.Errorf("numRooms must be positive, got %d", numRooms)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Collect the IDs as the rooms are built. Ranging over m.Rooms instead
	// would pick up rooms from an earlier split and, because Go randomizes
	// map iteration order, would scramble the round-robin across runs.
	roomIDs := make([]string, 0, numRooms)
	for i := 0; i < numRooms; i++ {
		roomID := fmt.Sprintf("%s-br-%d", m.MeetingID, i)
		m.Rooms[roomID] = &BreakoutRoom{
			ID:   roomID,
			Name: fmt.Sprintf("Breakout Room %d", i+1),
			// Each breakout room is a media session of its own: the SFU
			// forwards streams only within a room, which is the point.
			MediaSession: &MediaSession{
				MeetingID:   roomID,
				Publishers:  make(map[string]*Publisher),
				Subscribers: make(map[string]*Subscriber),
			},
		}
		roomIDs = append(roomIDs, roomID)
	}

	// Distribute participants round-robin
	for i, participantID := range participants {
		roomID := roomIDs[i%numRooms]
		m.Rooms[roomID].Participants = append(m.Rooms[roomID].Participants, participantID)
	}

	return nil
}
```

### 3. Meeting Service

The Meeting Service manages the full lifecycle of a meeting from scheduling through recording delivery. It handles participant join/leave events, enforces waiting room admission policies, tracks who is speaking (active speaker detection), and initiates recordings to S3. Participant state is stored both in PostgreSQL for durability and in Redis for fast real-time lookups, with the PostgreSQL record serving as the source of truth for billing and audit purposes.

`Authorize` is the concrete implementation behind the `MeetingDirectory` interface the Signaling Service declared above. The two packages agree on `MeetingAuth` and `MeetingSettings` through a small shared contract package that both import, which is why each snippet here declares them locally. Note where the randomness comes from in this service: meeting IDs and passcodes are drawn from `crypto/rand`, never from the clock. A passcode an attacker can predict is not a passcode.

```go
package meeting

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// MeetingService manages meeting creation and lifecycle
type MeetingService struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

// Meeting represents a scheduled or ad-hoc meeting
type Meeting struct {
	ID          string          `json:"id"`
	HostID      string          `json:"host_id"`
	Title       string          `json:"title"`
	ScheduledAt *time.Time      `json:"scheduled_at,omitempty"`
	Duration    int             `json:"duration_minutes"`
	Status      string          `json:"status"` // scheduled, active, ended
	PassCode    string          `json:"pass_code,omitempty"`
	Settings    MeetingSettings `json:"settings"`
	CreatedAt   time.Time       `json:"created_at"`
}

// CreateMeeting creates a new meeting
func (s *MeetingService) CreateMeeting(ctx context.Context, hostID, title string, scheduledAt *time.Time) (*Meeting, error) {
	id, err := generateMeetingID() // e.g., 123-456-7890 format
	if err != nil {
		return nil, err
	}
	passCode, err := generatePassCode()
	if err != nil {
		return nil, err
	}

	meeting := &Meeting{
		ID:          id,
		HostID:      hostID,
		Title:       title,
		ScheduledAt: scheduledAt,
		Duration:    60,
		Status:      "scheduled",
		PassCode:    passCode,
		Settings: MeetingSettings{
			WaitingRoomEnabled: true,
			MaxParticipants:    100,
		},
		CreatedAt: time.Now(),
	}

	// settings is a jsonb column. pgx cannot infer an encoding for an
	// arbitrary Go struct, so marshal it explicitly.
	settings, err := json.Marshal(meeting.Settings)
	if err != nil {
		return nil, err
	}

	_, err = s.db.Exec(ctx, `
		INSERT INTO meetings (id, host_id, title, scheduled_at, status, pass_code, settings, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
		meeting.ID, meeting.HostID, meeting.Title, meeting.ScheduledAt,
		meeting.Status, meeting.PassCode, settings,
	)
	if err != nil {
		return nil, err
	}

	return meeting, nil
}

// MeetingSettings are the host-controlled policies for a meeting. They are
// stored as jsonb so new toggles do not need a migration.
type MeetingSettings struct {
	WaitingRoomEnabled bool     `json:"waiting_room_enabled"`
	MaxParticipants    int      `json:"max_participants"`
	MuteOnEntry        bool     `json:"mute_on_entry"`
	RecordingEnabled   bool     `json:"recording_enabled"`
	E2EEncryption      bool     `json:"e2e_encryption"`
	CoHostIDs          []string `json:"co_host_ids,omitempty"`
}

// StartMeeting activates a meeting and assigns a media server
func (s *MeetingService) StartMeeting(ctx context.Context, meetingID, hostID string) (*MeetingSession, error) {
	meeting, err := s.getMeeting(ctx, meetingID)
	if err != nil {
		return nil, err
	}

	if meeting.HostID != hostID {
		return nil, fmt.Errorf("only host can start meeting")
	}

	// Select nearest available media server
	mediaServer, err := s.selectMediaServer(ctx)
	if err != nil {
		return nil, fmt.Errorf("no media server available: %w", err)
	}

	session := &MeetingSession{
		MeetingID:       meetingID,
		MediaServerAddr: mediaServer,
		StartedAt:       time.Now(),
	}

	// Store active session in Redis
	s.rdb.HSet(ctx, fmt.Sprintf("meeting:active:%s", meetingID),
		"media_server", mediaServer,
		"started_at", time.Now().Unix(),
		"host_id", hostID,
	)
	s.rdb.Expire(ctx, fmt.Sprintf("meeting:active:%s", meetingID), 24*time.Hour)

	// Update status
	s.db.Exec(ctx, "UPDATE meetings SET status = 'active', started_at = NOW() WHERE id = $1", meetingID)

	return session, nil
}

// ErrNotAuthorized is returned for every rejected join, whatever the real
// reason. See Authorize.
var ErrNotAuthorized = errors.New("not authorized to join this meeting")

// MeetingAuth is what the Signaling Service needs to admit a participant.
type MeetingAuth struct {
	HostID          string
	MediaServerAddr string
	Settings        MeetingSettings
}

// Authorize decides whether a user may join a meeting. This is the check
// that stands between a guessed nine-digit meeting ID and a room full of
// strangers, and its absence is what "Zoombombing" exploited in 2020.
func (s *MeetingService) Authorize(ctx context.Context, meetingID, userID, passCode string) (MeetingAuth, error) {
	var hostID, status, wantCode string
	var rawSettings []byte

	err := s.db.QueryRow(ctx,
		"SELECT host_id, status, pass_code, settings FROM meetings WHERE id = $1",
		meetingID,
	).Scan(&hostID, &status, &wantCode, &rawSettings)
	if errors.Is(err, pgx.ErrNoRows) {
		// Deliberately the same error as a bad passcode. Distinguishing
		// "no such meeting" from "wrong passcode" turns this endpoint into
		// an oracle for enumerating which meeting IDs are live.
		return MeetingAuth{}, ErrNotAuthorized
	}
	if err != nil {
		return MeetingAuth{}, err
	}
	if status == "ended" {
		return MeetingAuth{}, ErrNotAuthorized
	}

	// The host is admitted on identity. Everyone else presents the
	// passcode, compared in constant time so that response latency does
	// not reveal how many leading digits were correct.
	if userID != hostID && subtle.ConstantTimeCompare([]byte(passCode), []byte(wantCode)) != 1 {
		return MeetingAuth{}, ErrNotAuthorized
	}

	var settings MeetingSettings
	if err := json.Unmarshal(rawSettings, &settings); err != nil {
		return MeetingAuth{}, err
	}

	addr, err := s.rdb.HGet(ctx, fmt.Sprintf("meeting:active:%s", meetingID), "media_server").Result()
	if err != nil {
		return MeetingAuth{}, fmt.Errorf("meeting %s is not started: %w", meetingID, err)
	}

	return MeetingAuth{HostID: hostID, MediaServerAddr: addr, Settings: settings}, nil
}

// selectMediaServer picks the least-loaded media server in the region
func (s *MeetingService) selectMediaServer(ctx context.Context) (string, error) {
	// Get available servers sorted by current load
	servers, err := s.rdb.ZRangeByScore(ctx, "media_servers:load",
		&redis.ZRangeBy{Min: "0", Max: "80", Count: 1}).Result()
	if err != nil || len(servers) == 0 {
		return "", fmt.Errorf("no available servers")
	}
	return servers[0], nil
}

func (s *MeetingService) getMeeting(ctx context.Context, meetingID string) (*Meeting, error) {
	var m Meeting
	err := s.db.QueryRow(ctx,
		"SELECT id, host_id, title, status FROM meetings WHERE id = $1",
		meetingID,
	).Scan(&m.ID, &m.HostID, &m.Title, &m.Status)
	return &m, err
}

type MeetingSession struct {
	MeetingID       string
	MediaServerAddr string
	StartedAt       time.Time
}

// generateMeetingID returns a 10-digit ID formatted 123-456-7890. Digits,
// not hex or base32: the ID has to survive being read aloud on a phone
// bridge and typed into a dial-in keypad.
//
// The digits come from crypto/rand rather than a counter or a timestamp.
// A 10-digit space is only 10^10 wide and meeting IDs are enumerable by
// anyone willing to spend requests, which is why the ID alone is never the
// access control (see the passcode below and the join check in signaling).
func generateMeetingID() (string, error) {
	d, err := randomDigits(10)
	if err != nil {
		return "", err
	}
	return d[:3] + "-" + d[3:6] + "-" + d[6:], nil
}

// generatePassCode returns the six-digit numeric passcode. Deriving it from
// the clock, as in fmt.Sprintf("%06d", time.Now().UnixNano()%1000000),
// looks random but is not: an attacker who knows roughly when a meeting was
// created can search the handful of microsecond values in that window.
func generatePassCode() (string, error) {
	return randomDigits(6)
}

// randomDigits draws n uniformly distributed decimal digits. rand.Int with
// a bound of 10 is rejection-sampled by the standard library, so there is
// no modulo bias toward the low digits.
func randomDigits(n int) (string, error) {
	buf := make([]byte, n)
	for i := range buf {
		v, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", fmt.Errorf("generate random digits: %w", err)
		}
		buf[i] = byte('0' + v.Int64())
	}
	return string(buf), nil
}
```

---
