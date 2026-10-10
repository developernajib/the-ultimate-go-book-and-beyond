## 102P.12 WebRTC Production Concerns

### STUN vs TURN Deployment

Understanding the distinction between STUN and TURN is fundamental to diagnosing connection failures in production: STUN is a cheap discovery mechanism that reveals a peer's public address, while TURN is an active relay that forwards all media through a server when a direct path is impossible. The diagram below traces the full ICE negotiation path, showing when STUN succeeds (reflexive candidate) and when the fallback to a TURN relay becomes necessary.

```
Client A (behind NAT)               Client B (behind NAT)
       |                                    |
       |--- STUN request -----> STUN server (public IP)
       |<-- reflexive address (A's public IP:port) ---
       |
       |--- ICE candidate (reflexive) --> Signaling Server --> Client B
       |
       [ICE connectivity checks between A and B]
       |
       [If direct path fails → TURN relay]
       |
       |--- TURN Allocate ----> TURN server
       |<-- relay address ------
       |--- relay candidate --> Signaling Server --> Client B
       |
       A <===== media via TURN relay =====> B
```

**STUN** (Session Traversal Utilities for NAT) only helps discover the public reflexive address. It does not relay traffic.

**TURN** (Traversal Using Relays around NAT) relays all media when direct or STUN-derived paths fail (symmetric NAT, strict corporate firewalls). TURN traffic costs bandwidth - budget ~2 Mbps per relayed HD stream.

In production ~15-20% of connections require TURN. Always deploy TURN or you will see unexplained "connection failed" in enterprise networks.

### coturn Configuration (Reference)

coturn is the most widely deployed open-source TURN server. Its configuration file controls everything from TLS certificates to per-allocation bandwidth caps and peer IP restrictions. The settings below enforce time-limited HMAC credentials, restrict relay targets to prevent SSRF attacks via the TURN server, and enable TLS on port 5349 so media can traverse firewalls that block plain UDP.

```ini
# /etc/turnserver.conf - production coturn config

listening-port=3478
tls-listening-port=5349

# Fingerprint for WebRTC compatibility
fingerprint

# Long-term credential mechanism
lt-cred-mech
use-auth-secret
static-auth-secret=REPLACE_WITH_STRONG_SECRET_FROM_VAULT

# TLS certificates (use certbot / Let's Encrypt)
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# Restrict relay addresses to prevent SSRF attacks
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

# Bandwidth cap per allocation (bytes/sec)
max-bps=2000000

# Log to syslog
syslog
```

### Generating Ephemeral TURN Credentials in Go

Rather than issuing long-lived static TURN credentials that could be extracted from client-side JavaScript, production deployments generate short-lived HMAC-SHA1 credentials using a shared secret known only to the server. The credential embeds the expiry timestamp in the username field so the TURN server can reject it without database lookups once the TTL expires.

```go
package turn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"time"
)

// TURNCredential is a short-lived HMAC credential for coturn.
type TURNCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
	TTL      int    `json:"ttl"`
	URIs     []string `json:"uris"`
}

// GenerateCredential creates a time-limited TURN credential.
// secret must be the same static-auth-secret set in coturn.
func GenerateCredential(userID, secret string, ttl time.Duration) TURNCredential {
	expiry := time.Now().Add(ttl).Unix()
	username := fmt.Sprintf("%d:%s", expiry, userID)

	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return TURNCredential{
		Username: username,
		Password: password,
		TTL:      int(ttl.Seconds()),
		URIs: []string{
			"turn:turn.example.com:3478?transport=udp",
			"turn:turn.example.com:3478?transport=tcp",
			"turns:turn.example.com:5349?transport=tcp",
		},
	}
}
```

Credentials expire after `ttl` (typically 1 hour), preventing credential reuse or abuse.

### ICE Connection Establishment - Target <500 ms

| Phase | Typical Latency | Optimization |
|---|---|---|
| Signaling round-trip | 50-150 ms | Deploy signaling server close to users (multi-region) |
| ICE gathering (host candidates) | 10-30 ms | Pre-gather candidates before call starts |
| ICE gathering (STUN reflexive) | 30-100 ms | Use anycast STUN servers |
| ICE connectivity checks | 50-200 ms | Prioritize host > reflexive > relay in ICE candidate ordering |
| DTLS handshake | 10-50 ms | Reuse DTLS sessions where possible |

Total P50 target: **< 500 ms** from "call started" to first media packet.

### WebRTC Metrics to Monitor

Tracking WebRTC-specific metrics exposes call quality degradation that generic HTTP metrics miss entirely, packet loss above 2%, jitter above 50 ms, and round-trip times above 200 ms are reliable predictors of user-perceived audio/video quality drops. The Prometheus gauges and histograms below capture per-call transport statistics so dashboards can correlate ICE candidate type (host/reflexive/relay) with quality outcomes and drive SLO alerting.

```go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// ICE connection outcomes
	ICEConnectionSuccess = promauto.NewCounter(prometheus.CounterOpts{
		Name: "webrtc_ice_connection_success_total",
		Help: "Number of successfully established ICE connections.",
	})
	ICEConnectionFailed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "webrtc_ice_connection_failed_total",
		Help: "Number of failed ICE connection attempts.",
	})

	// Candidate type used for the final connection
	ICECandidateType = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "webrtc_ice_candidate_type_total",
		Help: "ICE candidate type used for successful connections.",
	}, []string{"type"}) // "host", "srflx", "relay"

	// ICE gathering duration histogram
	ICEGatheringDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "webrtc_ice_gathering_duration_seconds",
		Help:    "Time to complete ICE candidate gathering.",
		Buckets: prometheus.DefBuckets,
	})

	// Per-stream packet loss percentage (reported by client via stats API)
	PacketLoss = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "webrtc_packet_loss_percent",
		Help:    "Observed RTP packet loss percentage.",
		Buckets: []float64{0, 0.5, 1, 2, 5, 10, 20, 50},
	})

	// Jitter in milliseconds
	Jitter = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "webrtc_jitter_ms",
		Help:    "RTP jitter in milliseconds.",
		Buckets: []float64{0, 5, 10, 20, 50, 100, 200},
	})

	// Round-trip time
	RTT = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "webrtc_rtt_ms",
		Help:    "Round-trip time in milliseconds (from RTCP SR/RR).",
		Buckets: []float64{10, 25, 50, 100, 200, 500, 1000},
	})

	// Active peer connections
	ActivePeers = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "webrtc_active_peers",
		Help: "Number of currently connected WebRTC peers.",
	})
)
```

### Client Stats Collection Endpoint

Clients report `RTCStatsReport` every 5 seconds via a lightweight HTTP POST:

```go
package statsapi

import (
	"encoding/json"
	"net/http"

	"yourmodule/metrics"
)

// ClientStats is sent by the browser's getStats() API.
type ClientStats struct {
	PacketLossPct  float64 `json:"packetLossPct"`
	JitterMs       float64 `json:"jitterMs"`
	RTTMs          float64 `json:"rttMs"`
	CandidateType  string  `json:"candidateType"` // "host" | "srflx" | "relay"
	ICEGatheringMs float64 `json:"iceGatheringMs"`
}

// HandleStats receives periodic stats from WebRTC clients.
func HandleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var stats ClientStats
	if err := json.NewDecoder(r.Body).Decode(&stats); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	metrics.PacketLoss.Observe(stats.PacketLossPct)
	metrics.Jitter.Observe(stats.JitterMs)
	metrics.RTT.Observe(stats.RTTMs)
	metrics.ICEGatheringDuration.Observe(stats.ICEGatheringMs / 1000.0)

	if stats.CandidateType != "" {
		metrics.ICECandidateType.WithLabelValues(stats.CandidateType).Inc()
	}

	w.WriteHeader(http.StatusNoContent)
}
```

### Scaling TURN Servers

```
                     ┌───────────────────────────────────────────┐
                     │          Load Balancer (UDP/TCP)          │
                     │    (HAProxy / AWS NLB / Nginx stream)     │
                     └────────┬──────────────┬──────────────┬────┘
                              │              │              │
                     ┌────────▼──┐  ┌────────▼──┐  ┌────────▼──┐
                     │ TURN us-1 │  │ TURN us-2 │  │ TURN eu-1 │
                     │ (coturn)  │  │ (coturn)  │  │ (coturn)  │
                     └───────────┘  └───────────┘  └───────────┘
```

- Use DNS-based geo-routing (Route 53 latency routing) to direct clients to the nearest TURN region.
- Each coturn instance is stateless for UDP relay - horizontal scaling is straightforward.
- Monitor `turnserver_total_sessions` Prometheus metric exported by coturn.
- Budget: 1 Gbps NIC per TURN node handles ~400 concurrent HD relayed streams.

### Junior → FAANG: STUN vs TURN and Why You Always Need Both

STUN (Session Traversal Utilities for NAT) helps a client discover its public IP and port by asking a STUN server "what does my connection look like from the outside?" This works for clients behind simple NAT (like a home router). TURN (Traversal Using Relays around NAT) provides a relay when STUN fails: for clients behind symmetric NAT or strict firewalls that block peer-to-peer UDP, TURN relays all media through a server.

The rule of thumb: always deploy both. STUN is cheap (stateless, handles thousands of requests per second per core). TURN is expensive (relays all media, bandwidth-constrained at ~400 HD streams per 1 Gbps NIC). The ICE fallback order is: host candidates first (direct local connection, fastest), then STUN reflexive candidates (NAT traversal), then TURN relay (always works but uses server bandwidth). Most connections succeed without TURN. TURN is the fallback for the fraction of users behind strict firewalls.

Interview entry point: "you always need TURN as a fallback because some fraction of users cannot establish peer-to-peer connections due to symmetric NAT or strict enterprise firewalls. Without TURN, those users cannot join calls."

### Senior @ FAANG: TURN Capacity Planning and ICE Success Rate as an SLO

TURN capacity planning requires knowing: the fraction of connections that require TURN (typically 15-30% depending on the user base's network environment), the average bandwidth per relayed stream (depends on video resolution and codec), and the target ICE success rate SLO.

At 10,000 concurrent sessions with 20% requiring TURN, you have 2,000 relayed streams. At 500 Kbps average per HD stream, that is 1 Gbps of TURN bandwidth. One 1 Gbps NIC handles exactly this load with no headroom. For production, provision 2x capacity (2 Gbps across multiple TURN nodes) with geographic distribution so a single node failure does not degrade ICE success rate.

ICE success rate is the primary reliability SLO for a WebRTC deployment. A 95% ICE success rate means 5% of connection attempts fail (users cannot join calls). At 100,000 attempts per day, that is 5,000 failed call attempts daily. Monitoring ICE success rate by candidate type (host, srflx, relay), by user network (mobile vs corporate WiFi), and by geographic region reveals which TURN nodes are undersized and which networks have unusual NAT traversal problems.

---
