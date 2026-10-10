## 102P.10 SFU Architecture Deep Dive

A **Selective Forwarding Unit (SFU)** is a media server that receives tracks from each participant and forwards them selectively to other participants. Unlike a Mesh (pure P2P) or MCU (Multipoint Control Unit), an SFU does not decode or mix streams - it routes encoded packets, keeping CPU usage low while reducing each client's upload count to one.

### Topology Comparison

| Architecture | Uploads per Client | Server CPU | Server Bandwidth | Best For |
|---|---|---|---|---|
| **Mesh (P2P)** | N-1 | None | None | ≤4 participants |
| **MCU** | 1 (composite) | Very High (decode+mix) | Low | Legacy conferencing |
| **SFU** | 1 per track | Low (forward only) | High | Modern video calls, ≥4 participants |

At 8 participants with 720p video (1.5 Mbps each):
- **Mesh**: Each client uploads 7 × 1.5 = 10.5 Mbps. Total upload = 56 Mbps combined.
- **SFU**: Each client uploads 1 × 1.5 = 1.5 Mbps. Server forwards 8 × 7 = 56 Mbps, but clients only spend 1.5 Mbps upload each.

### Simulcast - Multiple Quality Layers

Simulcast lets each sender encode three spatial layers (high/medium/low). The SFU forwards the appropriate layer per receiver based on available bandwidth, screen layout, or explicit request.

```
Sender (Chrome/Firefox)
  ├── Layer 0: 1280×720  @ 1.5 Mbps  (high)
  ├── Layer 1: 640×360   @ 400 Kbps  (medium)
  └── Layer 2: 320×180   @ 120 Kbps  (low)
```

The SFU subscribes each receiver to a layer and can switch layers without renegotiation by sending a PLI (Picture Loss Indication) to request a new keyframe from the sender.

### Building a Go SFU with pion/webrtc

The core challenge in an SFU is track fan-out under concurrent joins and leaves. The implementation below uses a `TrackLocalStaticRTP` as the SFU's outbound copy of each inbound track: when peer A's `OnTrack` fires, the SFU creates one `TrackLocalStaticRTP`, registers it on the `Peer` struct, then calls `AddTrack` on every other peer's `PeerConnection`. A goroutine then reads raw RTP bytes from the remote track and writes them verbatim to the local track, no decode, no re-encode, minimal latency.

```go
package sfu

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v3"
)

// Room holds all peers in a single conference.
type Room struct {
	mu    sync.RWMutex
	peers map[string]*Peer
}

// Peer represents one participant with a pion PeerConnection.
type Peer struct {
	id   string
	pc   *webrtc.PeerConnection
	room *Room

	// tracksMu guards localTracks published by this peer.
	tracksMu    sync.RWMutex
	localTracks []*webrtc.TrackLocalStaticRTP
}

// NewRoom creates an empty conference room.
func NewRoom() *Room {
	return &Room{peers: make(map[string]*Peer)}
}

// AddPeer creates a PeerConnection for a new participant and wires up track routing.
func (r *Room) AddPeer(id string) (*Peer, error) {
	cfg := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}

	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		return nil, fmt.Errorf("create peer connection: %w", err)
	}

	p := &Peer{id: id, pc: pc, room: r}

	// When this peer sends a track, subscribe all existing peers to it.
	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("[SFU] peer %s added track %s/%s", id, remoteTrack.Kind(), remoteTrack.ID())

		localTrack, err := webrtc.NewTrackLocalStaticRTP(
			remoteTrack.Codec().RTPCodecCapability,
			remoteTrack.ID(),
			remoteTrack.StreamID(),
		)
		if err != nil {
			log.Printf("[SFU] create local track: %v", err)
			return
		}

		// Register this track so future peers also get it.
		p.tracksMu.Lock()
		p.localTracks = append(p.localTracks, localTrack)
		p.tracksMu.Unlock()

		// Push track to every other peer currently in the room.
		r.mu.RLock()
		for otherId, other := range r.peers {
			if otherId == id {
				continue
			}
			if _, err := other.pc.AddTrack(localTrack); err != nil {
				log.Printf("[SFU] add track to %s: %v", otherId, err)
			}
		}
		r.mu.RUnlock()

		// Forward RTP packets from remote track → local track.
		go forwardRTP(remoteTrack, localTrack, pc)
	})

	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		log.Printf("[SFU] peer %s ICE state: %s", id, s)
		if s == webrtc.ICEConnectionStateFailed || s == webrtc.ICEConnectionStateClosed {
			r.RemovePeer(id)
		}
	})

	r.mu.Lock()
	// Subscribe this new peer to all existing tracks.
	for _, existingPeer := range r.peers {
		existingPeer.tracksMu.RLock()
		for _, t := range existingPeer.localTracks {
			if _, err := pc.AddTrack(t); err != nil {
				log.Printf("[SFU] subscribe new peer to existing track: %v", err)
			}
		}
		existingPeer.tracksMu.RUnlock()
	}
	r.peers[id] = p
	r.mu.Unlock()

	return p, nil
}

// RemovePeer closes and removes a participant from the room.
func (r *Room) RemovePeer(id string) {
	r.mu.Lock()
	p, ok := r.peers[id]
	if ok {
		delete(r.peers, id)
	}
	r.mu.Unlock()

	if ok {
		_ = p.pc.Close()
		log.Printf("[SFU] removed peer %s", id)
	}
}

// forwardRTP reads packets from remoteTrack and writes them to localTrack.
// It also sends REMB feedback for bandwidth estimation.
func forwardRTP(
	remote *webrtc.TrackRemote,
	local *webrtc.TrackLocalStaticRTP,
	pc *webrtc.PeerConnection,
) {
	buf := make([]byte, 1500)
	for {
		n, _, err := remote.Read(buf)
		if err != nil {
			return
		}
		if _, err = local.Write(buf[:n]); err != nil {
			return
		}

		// Send Receiver Estimated Max Bitrate (REMB) every ~200 packets
		// In production, use a proper bandwidth estimator (e.g., google-cc).
		if err = pc.WriteRTCP([]rtcp.Packet{
			&rtcp.ReceiverEstimatedMaximumBitrate{
				Bitrate: 1_500_000, // 1.5 Mbps target
				SSRCs:   []uint32{uint32(remote.SSRC())},
			},
		}); err != nil {
			return
		}
	}
}

// SDPSignal carries SDP offer/answer between the HTTP layer and the SFU.
type SDPSignal struct {
	Type string `json:"type"` // "offer" | "answer"
	SDP  string `json:"sdp"`
}

// ICESignal carries a single ICE candidate.
type ICESignal struct {
	Candidate string `json:"candidate"`
	SDPMid    string `json:"sdpMid"`
	SDPMLineIndex uint16 `json:"sdpMLineIndex"`
}

// HandleOffer processes an SDP offer from a new peer and returns an answer.
func (p *Peer) HandleOffer(offerJSON []byte) ([]byte, error) {
	var sig SDPSignal
	if err := json.Unmarshal(offerJSON, &sig); err != nil {
		return nil, err
	}

	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  sig.SDP,
	}
	if err := p.pc.SetRemoteDescription(offer); err != nil {
		return nil, fmt.Errorf("set remote description: %w", err)
	}

	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return nil, fmt.Errorf("create answer: %w", err)
	}
	if err = p.pc.SetLocalDescription(answer); err != nil {
		return nil, fmt.Errorf("set local description: %w", err)
	}

	// Wait for ICE gathering to complete (trickle ICE omitted here for simplicity).
	<-webrtc.GatheringCompletePromise(p.pc)

	resp := SDPSignal{Type: "answer", SDP: p.pc.LocalDescription().SDP}
	return json.Marshal(resp)
}

// AddICECandidate adds a trickle-ICE candidate received from the remote peer.
func (p *Peer) AddICECandidate(candidateJSON []byte) error {
	var sig ICESignal
	if err := json.Unmarshal(candidateJSON, &sig); err != nil {
		return err
	}
	return p.pc.AddICECandidate(webrtc.ICECandidateInit{
		Candidate:     sig.Candidate,
		SDPMid:        &sig.SDPMid,
		SDPMLineIndex: &sig.SDPMLineIndex,
	})
}
```

### Bandwidth Estimation: REMB vs TWCC

| Mechanism | Direction | How it works |
|---|---|---|
| **REMB** (Receiver Estimated Max Bitrate) | Receiver → Sender | Receiver measures packet loss/jitter, sends estimated max bitrate via RTCP |
| **TWCC** (Transport-Wide Congestion Control) | Receiver → Sender | Receiver timestamps every packet, sends sequence-number feedback. Sender runs GCC algorithm |

TWCC is preferred in modern deployments (Chrome ≥ M77) because it gives the sender finer-grained delay-gradient information for the Google Congestion Control (GCC) algorithm.

In pion, enable TWCC by requesting the `transport-cc` RTP header extension in your media engine and writing `rtcp.TransportLayerCC` feedback packets.

### Simulcast Layer Switching

The SFU decides which simulcast layer to forward per-receiver based on signals such as available downlink bandwidth, the receiver's viewport size (a thumbnail tile needs only the low layer), or an explicit quality preference from the application. Switching is achieved by toggling the `Active` flag on individual `RTPEncodingParameters` entries identified by their RID string, then flushing a PLI to the sender so the receiver can start decoding the new layer from a clean keyframe rather than a mid-stream delta.

```go
// switchLayer requests the SFU to forward a different simulcast layer to a receiver.
// rid is the RTP stream identifier: "high", "medium", or "low".
func switchLayer(sender *webrtc.RTPSender, rid string) error {
	parameters := sender.GetParameters()
	for i := range parameters.Encodings {
		if parameters.Encodings[i].RID == rid {
			parameters.Encodings[i].Active = true
		} else {
			parameters.Encodings[i].Active = false
		}
	}
	return sender.SetParameters(parameters)
}
```

When switching layers, send a **PLI** (Picture Loss Indication) RTCP packet to request a keyframe so the receiver can decode without waiting for the next natural keyframe.

### Junior → FAANG: SFU vs MCU vs Mesh in Three Sentences Each

Mesh (P2P): every participant sends video directly to every other participant. Simple signaling, no media server needed. Client bandwidth and CPU scale as O(N) with participants. Breaks at 4-5 participants due to upload bandwidth constraints.

SFU: every participant sends video to the SFU once. The SFU forwards each stream to the other participants. Client upload is O(1), server forwarding is O(N²) in packets but O(N) in streams. Works well up to 50-100 participants. PLI for keyframes on layer switches is the detail that shows SFU knowledge depth.

MCU: every participant sends video to the MCU. The MCU decodes all streams, mixes them into a composite, and sends one stream per participant. Client sees one video regardless of participant count. Server CPU scales with participant count and resolution. Used for very large calls where client bandwidth is the binding constraint, at the cost of server CPU.

### Senior @ FAANG: SFU Clustering and Cascading for Global Scale

A single SFU instance handles tens to hundreds of simultaneous participants before CPU or bandwidth becomes the constraint. At Discord scale (millions of concurrent voice connections) or Zoom's peak capacity, a single SFU is not sufficient. The solution is SFU clustering with cascading: multiple SFU instances, each serving a subset of participants in a room, forward their received tracks to other SFU instances in the cluster.

Cascading adds complexity: a track from participant A (on SFU-1) must be forwarded to SFU-2 and SFU-3 for participants on those instances to receive it. This creates a fan-out from each SFU to all other SFUs in the cluster. At N SFU instances, the cascading bandwidth grows as O(N) for each participant's track. The session management system that decides how participants are distributed across SFU instances (and when to rebalance) must optimize for minimizing cascading bandwidth while keeping each SFU instance within its capacity limit.

The geographic dimension: for global sessions, participants in different regions connect to region-local SFU instances, which cascade to each other across regional links. The inter-region link bandwidth and latency are the limiting factors for global session quality. The media architecture must define the maximum inter-region hops for a cascaded stream, because each hop adds latency and packet loss opportunities.

---
