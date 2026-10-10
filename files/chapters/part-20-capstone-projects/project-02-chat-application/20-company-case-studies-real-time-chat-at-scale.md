## Company Case Studies: Real-Time Chat at Scale

The architectural patterns explored in this project mirror those used by the world's largest messaging platforms. In this section, you will see how companies like Slack, Discord, and WhatsApp solve the unique challenges of real-time chat at massive scale -- from handling millions of concurrent WebSocket connections to ensuring message delivery guarantees across distributed systems. Each case study includes Go-style code examples that illustrate the key design decisions these companies have made, giving you concrete patterns you can reference in system design interviews.

### Slack: Enterprise Messaging Architecture

Slack handles billions of messages with real-time delivery:

```go
// Slack-style enterprise messaging system
package slack

import (
    "context"
    "encoding/json"
    "sync"
    "time"

    "github.com/gorilla/websocket"
    "github.com/redis/go-redis/v9"
)

// MessageService handles enterprise messaging at scale
type MessageService struct {
    redis         *redis.ClusterClient
    connections   *ConnectionManager
    searchClient  *ElasticsearchClient
    fileStore     *S3FileStore
}

// Message represents a Slack-style message
type Message struct {
    ID            string            `json:"id"`
    ChannelID     string            `json:"channel_id"`
    UserID        string            `json:"user_id"`
    ThreadTS      string            `json:"thread_ts,omitempty"`
    Text          string            `json:"text"`
    Blocks        []Block           `json:"blocks,omitempty"`
    Attachments   []Attachment      `json:"attachments,omitempty"`
    Reactions     map[string][]string `json:"reactions,omitempty"`
    Timestamp     string            `json:"ts"`
    Edited        *EditedInfo       `json:"edited,omitempty"`
    IsStarred     bool              `json:"is_starred"`
    PinnedTo      []string          `json:"pinned_to,omitempty"`
}

// Block represents Slack Block Kit elements
type Block struct {
    Type     string          `json:"type"`
    BlockID  string          `json:"block_id,omitempty"`
    Elements json.RawMessage `json:"elements,omitempty"`
    Text     *TextObject     `json:"text,omitempty"`
}

// ConnectionManager handles WebSocket connections per workspace
type ConnectionManager struct {
    mu          sync.RWMutex
    workspaces  map[string]*WorkspaceConnections
    redis       *redis.ClusterClient
}

type WorkspaceConnections struct {
    mu    sync.RWMutex
    users map[string][]*websocket.Conn // userID -> connections (multi-device)
}

// SendMessage delivers messages with real-time sync across devices
func (s *MessageService) SendMessage(ctx context.Context, msg *Message) error {
    // Generate unique timestamp ID
    msg.Timestamp = generateSlackTimestamp()
    msg.ID = msg.ChannelID + "." + msg.Timestamp

    // Process message blocks and attachments
    if err := s.processBlocks(ctx, msg); err != nil {
        return err
    }

    // Store message in database
    if err := s.storeMessage(ctx, msg); err != nil {
        return err
    }

    // Index for search
    go s.searchClient.IndexMessage(ctx, msg)

    // Publish to Redis for real-time delivery
    data, _ := json.Marshal(msg)
    s.redis.Publish(ctx, "channel:"+msg.ChannelID, data)

    // Handle @mentions and notifications
    s.processMentions(ctx, msg)

    return nil
}

// SubscribeToChannel handles real-time message subscription
func (s *MessageService) SubscribeToChannel(ctx context.Context, channelID, userID string, conn *websocket.Conn) error {
    pubsub := s.redis.Subscribe(ctx, "channel:"+channelID)
    defer pubsub.Close()

    ch := pubsub.Channel()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case msg := <-ch:
            if err := conn.WriteMessage(websocket.TextMessage, []byte(msg.Payload)); err != nil {
                return err
            }
        }
    }
}

// SearchMessages performs full-text search with filters
func (s *MessageService) SearchMessages(ctx context.Context, query *SearchQuery) (*SearchResults, error) {
    return s.searchClient.Search(ctx, &ElasticsearchQuery{
        Query:     query.Text,
        Channels:  query.InChannels,
        Users:     query.FromUsers,
        DateRange: query.DateRange,
        HasFile:   query.HasFile,
        IsStarred: query.IsStarred,
    })
}

func generateSlackTimestamp() string {
    now := time.Now()
    return fmt.Sprintf("%d.%06d", now.Unix(), now.Nanosecond()/1000)
}
```

### Discord: High-Performance Voice and Text

Discord handles millions of concurrent users:

```go
// Discord-style guild messaging with voice support
package discord

import (
    "context"
    "sync"
    "sync/atomic"

    "github.com/pion/webrtc/v3"
)

// GuildService manages Discord-style servers
type GuildService struct {
    guilds      sync.Map // guildID -> *Guild
    voiceStates sync.Map // userID -> *VoiceState
    shardCount  int
}

// Guild represents a Discord server
type Guild struct {
    ID            string             `json:"id"`
    Name          string             `json:"name"`
    OwnerID       string             `json:"owner_id"`
    Channels      map[string]*Channel `json:"channels"`
    Members       map[string]*Member  `json:"members"`
    Roles         map[string]*Role    `json:"roles"`
    VoiceRegion   string             `json:"voice_region"`
    MaxMembers    int                `json:"max_members"`
    PremiumTier   int                `json:"premium_tier"`
    mu            sync.RWMutex
}

// VoiceChannel handles real-time audio
type VoiceChannel struct {
    *Channel
    participants  sync.Map // userID -> *VoiceParticipant
    bitrate       int
    userLimit     int
}

// VoiceParticipant represents a user in voice
type VoiceParticipant struct {
    UserID      string
    GuildID     string
    ChannelID   string
    SessionID   string
    Deaf        bool
    Mute        bool
    SelfDeaf    bool
    SelfMute    bool
    Streaming   bool
    peerConn    *webrtc.PeerConnection
    audioTrack  *webrtc.TrackLocalStaticSample
}

// JoinVoice handles voice channel connection via WebRTC
func (v *VoiceChannel) JoinVoice(ctx context.Context, userID string) (*VoiceParticipant, error) {
    // Check user limit
    count := 0
    v.participants.Range(func(_, _ any) bool {
        count++
        return true
    })

    if v.userLimit > 0 && count >= v.userLimit {
        return nil, ErrVoiceChannelFull
    }

    // Create WebRTC peer connection
    config := webrtc.Configuration{
        ICEServers: []webrtc.ICEServer{
            {URLs: []string{"stun:stun.discord.gg:443"}},
        },
    }

    peerConn, err := webrtc.NewPeerConnection(config)
    if err != nil {
        return nil, err
    }

    // Create audio track
    audioTrack, err := webrtc.NewTrackLocalStaticSample(
        webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
        "audio",
        "discord-voice",
    )
    if err != nil {
        peerConn.Close()
        return nil, err
    }

    participant := &VoiceParticipant{
        UserID:     userID,
        ChannelID:  v.ID,
        SessionID:  generateSessionID(),
        peerConn:   peerConn,
        audioTrack: audioTrack,
    }

    v.participants.Store(userID, participant)

    // Notify other participants
    v.broadcastVoiceState(participant, "VOICE_STATE_UPDATE")

    return participant, nil
}

// BroadcastAudio distributes audio to all participants
func (v *VoiceChannel) BroadcastAudio(ctx context.Context, senderID string, audio []byte) error {
    v.participants.Range(func(key, value any) bool {
        userID := key.(string)
        participant := value.(*VoiceParticipant)

        // Don't send to self or deafened users
        if userID == senderID || participant.Deaf || participant.SelfDeaf {
            return true
        }

        // Write audio sample to track
        participant.audioTrack.WriteSample(media.Sample{
            Data:     audio,
            Duration: 20 * time.Millisecond, // Opus frame duration
        })

        return true
    })

    return nil
}
```

### WhatsApp: End-to-End Encrypted Messaging

WhatsApp's Signal Protocol implementation:

```go
// WhatsApp-style end-to-end encrypted messaging
package whatsapp

import (
    "context"
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"

    "golang.org/x/crypto/curve25519"
)

// E2EService handles end-to-end encryption
type E2EService struct {
    keyStore     KeyStore
    sessionStore SessionStore
}

// KeyPair represents a Curve25519 key pair
type KeyPair struct {
    PublicKey  [32]byte
    PrivateKey [32]byte
}

// PreKeyBundle for establishing encrypted sessions
type PreKeyBundle struct {
    IdentityKey    [32]byte `json:"identity_key"`
    SignedPreKey   [32]byte `json:"signed_pre_key"`
    PreKeyID       uint32   `json:"pre_key_id"`
    OneTimePreKey  [32]byte `json:"one_time_pre_key"`
    Signature      []byte   `json:"signature"`
}

// Session represents an encrypted messaging session
type Session struct {
    RemoteIdentity  [32]byte
    RootKey         [32]byte
    ChainKey        [32]byte
    MessageNumber   uint32
    PreviousCounter uint32
}

// EncryptMessage encrypts a message using the Signal Protocol
func (e *E2EService) EncryptMessage(ctx context.Context, senderID, recipientID string, plaintext []byte) (*EncryptedMessage, error) {
    // Get or create session
    session, err := e.getOrCreateSession(ctx, senderID, recipientID)
    if err != nil {
        return nil, err
    }

    // Derive message key from chain key
    messageKey := deriveMessageKey(session.ChainKey, session.MessageNumber)

    // Encrypt with AES-256-GCM
    block, err := aes.NewCipher(messageKey[:])
    if err != nil {
        return nil, err
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }

    nonce := make([]byte, gcm.NonceSize())
    rand.Read(nonce)

    ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

    // Ratchet chain key
    session.ChainKey = ratchetChainKey(session.ChainKey)
    session.MessageNumber++

    // Save session state
    e.sessionStore.Save(ctx, senderID, recipientID, session)

    return &EncryptedMessage{
        SenderID:      senderID,
        RecipientID:   recipientID,
        Ciphertext:    ciphertext,
        Nonce:         nonce,
        MessageNumber: session.MessageNumber - 1,
    }, nil
}

// DecryptMessage decrypts an incoming message
func (e *E2EService) DecryptMessage(ctx context.Context, msg *EncryptedMessage) ([]byte, error) {
    session, err := e.sessionStore.Get(ctx, msg.RecipientID, msg.SenderID)
    if err != nil {
        return nil, err
    }

    // Derive message key
    messageKey := deriveMessageKey(session.ChainKey, msg.MessageNumber)

    // Decrypt with AES-256-GCM
    block, err := aes.NewCipher(messageKey[:])
    if err != nil {
        return nil, err
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }

    plaintext, err := gcm.Open(nil, msg.Nonce, msg.Ciphertext, nil)
    if err != nil {
        return nil, err
    }

    return plaintext, nil
}

// X3DH performs Extended Triple Diffie-Hellman key agreement
func (e *E2EService) X3DH(ctx context.Context, senderKeys *KeyPair, bundle *PreKeyBundle) (*Session, error) {
    var sharedSecret [32]byte

    // DH1: IKa, SPKb
    var dh1 [32]byte
    curve25519.ScalarMult(&dh1, &senderKeys.PrivateKey, &bundle.SignedPreKey)

    // DH2: EKa, IKb
    ephemeralKey := generateKeyPair()
    var dh2 [32]byte
    curve25519.ScalarMult(&dh2, &ephemeralKey.PrivateKey, &bundle.IdentityKey)

    // DH3: EKa, SPKb
    var dh3 [32]byte
    curve25519.ScalarMult(&dh3, &ephemeralKey.PrivateKey, &bundle.SignedPreKey)

    // DH4: EKa, OPKb (if available)
    var dh4 [32]byte
    if bundle.OneTimePreKey != [32]byte{} {
        curve25519.ScalarMult(&dh4, &ephemeralKey.PrivateKey, &bundle.OneTimePreKey)
    }

    // Combine with KDF
    sharedSecret = kdf(dh1[:], dh2[:], dh3[:], dh4[:])

    return &Session{
        RemoteIdentity: bundle.IdentityKey,
        RootKey:        sharedSecret,
        ChainKey:       deriveChainKey(sharedSecret),
    }, nil
}
```

### Telegram: Cloud-Based Messaging

Telegram's distributed message storage:

```go
// Telegram-style cloud messaging with MTProto
package telegram

import (
    "context"
    "sync"
    "time"
)

// CloudMessageService handles distributed message storage
type CloudMessageService struct {
    datacenters map[string]*Datacenter
    router      *MessageRouter
    syncManager *SyncManager
}

// Datacenter represents a Telegram DC
type Datacenter struct {
    ID           int
    Region       string
    Primary      bool
    MessageStore MessageStore
    MediaStore   MediaStore
}

// MessageRouter routes messages to appropriate datacenters
type MessageRouter struct {
    dcs         map[int]*Datacenter
    userDCMap   sync.Map // userID -> dcID
}

// SyncState tracks message synchronization
type SyncState struct {
    UserID    string
    Pts       int32  // Message sequence number
    Qts       int32  // Secret chat sequence
    Date      int32
    Seq       int32
    Updates   []Update
}

// SendCloudMessage stores message across datacenters
func (s *CloudMessageService) SendCloudMessage(ctx context.Context, msg *Message) error {
    // Route to sender's datacenter
    senderDC := s.router.GetUserDC(msg.SenderID)

    // Store in primary DC
    pts, err := senderDC.MessageStore.Save(ctx, msg)
    if err != nil {
        return err
    }

    // Replicate to recipient's DC if different
    recipientDC := s.router.GetUserDC(msg.RecipientID)
    if recipientDC.ID != senderDC.ID {
        go s.replicateMessage(ctx, msg, recipientDC)
    }

    // Push update to online clients
    s.syncManager.PushUpdate(ctx, &Update{
        Type:      UpdateNewMessage,
        Message:   msg,
        Pts:       pts,
        PtsCount:  1,
    })

    return nil
}

// GetDifference syncs client state with server
func (s *CloudMessageService) GetDifference(ctx context.Context, userID string, pts, qts, date int32) (*Difference, error) {
    dc := s.router.GetUserDC(userID)

    // Fetch messages since client's last sync point
    messages, newPts, err := dc.MessageStore.GetSince(ctx, userID, pts)
    if err != nil {
        return nil, err
    }

    // Check if too many updates (client should reset)
    if len(messages) > 10000 {
        return &Difference{
            Type: DifferenceTooLong,
            Pts:  newPts,
        }, nil
    }

    return &Difference{
        Type:     DifferenceSlice,
        Messages: messages,
        Pts:      newPts,
    }, nil
}

// HandleMediaUpload processes large file uploads
func (s *CloudMessageService) HandleMediaUpload(ctx context.Context, upload *MediaUpload) (*Media, error) {
    dc := s.router.GetUserDC(upload.UserID)

    // For large files, use resumable upload
    if upload.Size > 10*1024*1024 { // 10MB
        return s.resumableUpload(ctx, dc, upload)
    }

    // Small files upload directly
    location, err := dc.MediaStore.Store(ctx, upload.Data, upload.MimeType)
    if err != nil {
        return nil, err
    }

    return &Media{
        Type:     upload.Type,
        Location: location,
        Size:     upload.Size,
    }, nil
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Slack | Block Kit UI, search indexing, enterprise SSO | 15M+ DAU |
| Discord | WebRTC voice, guild sharding, low latency | 150M+ MAU |
| WhatsApp | E2E encryption, Signal Protocol | 2B+ users |
| Telegram | Multi-DC sync, MTProto, cloud storage | 700M+ MAU |

---

### Junior → FAANG: What the Case Studies Teach About Constraints

Each company in this table solved the same problem with a different solution because their constraints were different. Slack optimized for enterprise reliability and audit compliance. Discord optimized for low-cost high-concurrency gaming chat. WhatsApp optimized for minimal data exposure and E2E privacy. Telegram optimized for multi-device sync and cloud message storage.

In a system design interview, starting your answer with "what are the key constraints here?" mirrors exactly this analysis. A chat system for a hospital (where message retention is legally required and E2E encryption is prohibited) is a completely different design than a consumer messaging app (where privacy is the selling point). Demonstrating that your design follows from the constraints, not from habit, is a strong interview signal.

Erlang/OTP (used historically by WhatsApp) and Go have similar concurrency models: lightweight processes (goroutines in Go, Erlang processes) that communicate by message passing. The fundamental insight that makes both scale is that a process per connection does not require an OS thread per connection. Go's scheduler maps goroutines to a small number of OS threads, similar to Erlang's BEAM VM. Understanding this parallelism model is useful context for any concurrency discussion in an interview.

### Senior @ FAANG: Case Studies as ADR References

At senior level, case studies are referenced directly in ADRs. When choosing between Redis Pub/Sub and Kafka for fan-out, the ADR can cite Discord's move from Redis to Kafka (documented in their engineering blog) as evidence for what the scaling threshold looks like and what the migration cost is. This grounds the decision in observed operational evidence rather than theoretical preference.

Discord's choice to rewrite their message counting from PostgreSQL to Cassandra (for append-only write-heavy workloads) and later their Go-to-Rust rewrite for the read services (for GC pause reduction) are both decisions driven by specific, measured operational problems. The pattern: identify the measured bottleneck, evaluate the solution options with their migration cost, choose the option with the best cost-benefit ratio given the team's operational experience. That decision process, documented explicitly, is what separates a principled architectural decision from a technology fashion choice.

Telegram's multi-datacenter synchronization model (writing to a primary DC, asynchronously replicating to secondary DCs, routing clients to their nearest DC) is the standard cross-region architecture for latency-sensitive services. The hard problem is what happens during a DC partition: do you serve stale data from the secondary (availability) or refuse to serve (consistency)? Telegram chose availability. WhatsApp chose consistency for message ordering. Both are valid choices for their respective user bases. Document your choice and the reasoning.

---
