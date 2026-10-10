## Production Go Implementation: Audio Streaming Pipeline

This service handles adaptive bitrate delivery, segment-based streaming, and gapless playback for millions of concurrent listeners. Unlike the simplified version in the Core Components section, it includes a bitrate controller that tracks bandwidth with an exponentially weighted moving average (EWMA), session management, CDN prefetching for look-ahead buffering, and atomic counters for metrics across concurrent goroutines.

The ladder has four rungs, not three. Spotify shipped lossless FLAC to Premium in September 2025, and it changes the shape of the controller rather than just adding a number to it. The three lossy rungs are separated by factors of roughly two, so climbing one is a modest bet. Lossless is eight times the bytes of the 160 kbps rung and it is variable-bitrate, which means the tier the controller is reasoning about has no fixed size. It is also the only rung that a listener has to ask for, and the only one that a fast network is not sufficient to justify. Treat it as a fourth rung and you will stream FLAC to Bluetooth earbuds that cannot carry it.

One further architectural point governs the bitrate controller and is worth stating before the code, because it is the most common way this component is designed wrong. Adaptive bitrate is fundamentally a client-side decision. The link that matters is the last mile between the edge node and the listener's phone, and the server cannot see that link at all. A server that times its own fetch from the CDN and calls the result "bandwidth" is measuring its own datacenter network, which is fast, stable, and completely irrelevant to whether the listener on a train is about to stall. So every input to the controller here arrives from the client, reported in request headers. The server aggregates and decides, the client measures. If you take one thing from this file, take that: instrument the link you are actually adapting to.

```go
package streaming

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// --- Audio Segment Types ---

type AudioQuality int

// The tiers the transcoding pipeline actually produces. Adding a rung here
// that the transcoder does not write means the controller can select a
// quality that 404s at the edge, so this list and the ladder in the
// transcoding pipeline are one decision expressed in two places.
const (
	QualityLow    AudioQuality = 96  // 96 kbps Ogg Vorbis
	QualityNormal AudioQuality = 160 // 160 kbps Ogg Vorbis
	QualityHigh   AudioQuality = 320 // 320 kbps Ogg Vorbis

	// QualityLossless is FLAC at up to 24-bit/44.1 kHz. Its value is the odd
	// one out: the lossy rungs are constant-bitrate, so their number is a
	// specification, while FLAC is variable and Spotify publishes no bitrate
	// for it at all. 1300 is a planning rate we derived, not a quoted spec:
	// 24-bit/44.1 kHz stereo PCM is 2117 kbps, and FLAC returns roughly 60%
	// of that on typical masters. Storage sizing, egress forecasting, and the
	// ABR gate below all read this one constant, which is the only reason it
	// is safe to have a derived number in an enum of measured ones.
	QualityLossless AudioQuality = 1300
)

func (q AudioQuality) String() string {
	switch q {
	case QualityLow:
		return "low"
	case QualityNormal:
		return "normal"
	case QualityHigh:
		return "high"
	case QualityLossless:
		return "lossless"
	default:
		return "unknown"
	}
}

// Ext returns the container extension for a tier. The lossy rungs are Ogg
// Vorbis and lossless is FLAC, so the extension is a function of the tier and
// never a hardcoded "ogg". Every key builder in the system routes through
// here: a caller that assumes .ogg silently 404s the moment lossless is the
// selected tier, and it 404s only for the listeners who opted into the
// feature, which is the hardest kind of bug to see from an aggregate dashboard.
func (q AudioQuality) Ext() string {
	if q == QualityLossless {
		return "flac"
	}
	return "ogg"
}

// ContentType is the MIME type for the tier's container. It moves with Ext for
// the same reason: a lossless segment served as audio/ogg is a FLAC payload
// wearing an Ogg label, and a strict client will refuse to decode it.
func (q AudioQuality) ContentType() string {
	if q == QualityLossless {
		return "audio/flac"
	}
	return "audio/ogg"
}

// segmentDurMs is the segment length used across the whole platform. It is a
// single constant because the capacity model, the transcoder's -segment_time,
// and the client's buffer math all have to agree on it.
const segmentDurMs int64 = 10_000

// AudioSegment represents a chunk of audio data for streaming.
type AudioSegment struct {
	TrackID    string
	SegmentIdx int
	Quality    AudioQuality
	Data       []byte
	DurationMs int64
	Encrypted  bool
}

// TrackManifest describes all available segments and qualities for a track.
//
// There is deliberately no encryption key here. The server hands out encrypted
// bytes and never decrypts them: the key travels to the client through the
// licensing path in the offline download manager, and a key sitting on the
// streaming host would be a copy of the crown jewels in a process that has no
// use for it.
type TrackManifest struct {
	TrackID    string
	Title      string
	Artist     string
	DurationMs int64
	Segments   int
	// Qualities must be sorted ascending by bitrate. SelectQuality relies on it.
	Qualities []AudioQuality
	FileIDs   map[AudioQuality]string // quality -> CDN file ID
}

// --- Adaptive Bitrate Controller ---

// BitrateController tracks client-reported network conditions and selects the
// quality tier to serve. All state is guarded by mu: a session is touched by
// concurrent segment requests, since a client pipelines its look-ahead fetches.
type BitrateController struct {
	mu             sync.Mutex
	currentQuality AudioQuality
	bandwidthEWMA  float64 // bits/sec, 0 means "no sample yet"
	haveSample     bool
	alpha          float64 // EWMA smoothing factor
	bufferLevelMs  int64
	haveBuffer     bool
}

const defaultQuality = QualityNormal

func NewBitrateController() *BitrateController {
	return &BitrateController{
		currentQuality: defaultQuality,
		alpha:          0.3,
	}
}

// RecordClientSample folds one client-measured segment download into the EWMA.
// sizeBytes and durationMs describe the client's fetch from the edge, not any
// fetch performed by this process.
func (bc *BitrateController) RecordClientSample(sizeBytes, durationMs int64) {
	if durationMs <= 0 || sizeBytes <= 0 {
		return
	}
	bc.mu.Lock()
	defer bc.mu.Unlock()

	bandwidthBps := float64(sizeBytes*8*1000) / float64(durationMs)
	if !bc.haveSample {
		bc.bandwidthEWMA = bandwidthBps
		bc.haveSample = true
		return
	}
	bc.bandwidthEWMA = bc.alpha*bandwidthBps + (1-bc.alpha)*bc.bandwidthEWMA
}

// UpdateBufferLevel records the client's current playback buffer depth.
func (bc *BitrateController) UpdateBufferLevel(bufferMs int64) {
	bc.mu.Lock()
	defer bc.mu.Unlock()
	bc.bufferLevelMs = bufferMs
	bc.haveBuffer = true
}

// CurrentQuality reports the last selected tier. Read under the lock: the
// caller races with concurrent segment requests on the same session.
func (bc *BitrateController) CurrentQuality() AudioQuality {
	bc.mu.Lock()
	defer bc.mu.Unlock()
	return bc.currentQuality
}

// SelectQuality chooses the best tier that fits the current estimate.
// available must be sorted ascending by bitrate.
func (bc *BitrateController) SelectQuality(available []AudioQuality) AudioQuality {
	if len(available) == 0 {
		// Indexing available[0] here would panic on a track whose manifest
		// arrived with no ladder, taking down the handler for one bad record.
		return defaultQuality
	}

	bc.mu.Lock()
	defer bc.mu.Unlock()

	// No sample yet means the very first segment of a session. Treating the
	// zero value as a bandwidth measurement would compare every tier against
	// 0 kbps, pick the floor, and open every stream on the planet at 96 kbps
	// including listeners on fibre. Absence of data is not a measurement of
	// zero, and the difference between those two is the whole bug.
	if !bc.haveSample {
		bc.currentQuality = clampQuality(defaultQuality, available)
		return bc.currentQuality
	}

	// Only spend 80% of the estimate. Headroom absorbs the variance that an
	// average hides, and switching down is more disruptive than starting lower.
	// The headroom matters more for FLAC than for the lossy rungs: 1300 is an
	// average of a variable bitrate, so a dense passage genuinely exceeds it,
	// where a 320 kbps Vorbis stream never exceeds 320.
	safeKbps := (bc.bandwidthEWMA / 1000) * 0.8

	// A draining buffer means a stall is imminent, so halve the target to
	// refill fast. Only when the client has actually told us the depth.
	if bc.haveBuffer && bc.bufferLevelMs < 5000 {
		safeKbps *= 0.5
	}

	// Highest tier that fits, floor of the ladder if none do. Playing at the
	// lowest quality beats not playing.
	best := available[0]
	for _, q := range available {
		if float64(q) <= safeKbps {
			best = q
		}
	}
	bc.currentQuality = best
	return best
}

// Entitlement carries everything that decides whether lossless may appear in
// a session's ladder at all. It is deliberately not just a boolean on the
// user: two of these three fields describe the moment, not the account.
type Entitlement struct {
	Premium        bool // lossless is a paid tier
	LosslessOptIn  bool // the user turned it on for this device
	TransportExact bool // the output path can carry the bits unaltered
}

// AvailableQualities filters a track's ladder down to what this session may
// actually receive, ascending. SelectQuality is then free to adapt within the
// result, and lossless can only enter the ladder through this gate.
//
// The gate exists because lossless is not simply "the next rung up". A phone
// on fibre still must not stream FLAC to Bluetooth headphones: no Bluetooth
// codec carries lossless, so the bits get re-encoded on the way to the ear and
// the listener pays for 8x the bytes to hear exactly what 320 kbps sounds
// like. Bandwidth is necessary and nowhere near sufficient, which is why an
// ABR controller must never be allowed to discover this tier on its own.
func AvailableQualities(ladder []AudioQuality, e Entitlement) []AudioQuality {
	allowed := e.Premium && e.LosslessOptIn && e.TransportExact
	out := make([]AudioQuality, 0, len(ladder))
	for _, q := range ladder {
		if q == QualityLossless && !allowed {
			continue
		}
		out = append(out, q)
	}
	return out
}

// clampQuality returns want if the track offers it, else the closest tier at or
// below it, else the floor.
func clampQuality(want AudioQuality, available []AudioQuality) AudioQuality {
	if len(available) == 0 {
		return defaultQuality
	}
	best := available[0]
	for _, q := range available {
		if q <= want {
			best = q
		}
	}
	return best
}

// --- Stream Session ---

// StreamSession manages an active audio streaming session for one user.
//
// Note what is absent: there is no Quality field. The selected tier lives in
// exactly one place, the BitrateController, and every caller reads it from
// there. Caching a copy on the session is the obvious-looking move and it is a
// trap. The controller adapts on every segment, nothing writes the copy back,
// and the look-ahead prefetch spends the rest of the stream warming the wrong
// bitrate while the metrics all look healthy. Two homes for one fact means the
// two disagree, and the stale one wins silently.
type StreamSession struct {
	SessionID string
	UserID    string
	TrackID   string
	Manifest  *TrackManifest
	Bitrate   *BitrateController
	StartedAt time.Time

	// Allowed is the manifest ladder already filtered by this session's
	// entitlement, computed once at session start. The controller adapts
	// within it, so lossless can never be selected on a session that was not
	// entitled to it, no matter what the bandwidth estimate later climbs to.
	Allowed []AudioQuality

	BytesStreamed  atomic.Int64
	SegmentsServed atomic.Int32

	// lastSeenUnix is the epoch-nanos of the most recent segment request.
	// atomic because the reaper reads it while request handlers write it.
	lastSeenUnix atomic.Int64
}

// NewStreamSession initializes a streaming session for a track.
func NewStreamSession(sessionID, userID string, manifest *TrackManifest) *StreamSession {
	s := &StreamSession{
		SessionID: sessionID,
		UserID:    userID,
		TrackID:   manifest.TrackID,
		Manifest:  manifest,
		Bitrate:   NewBitrateController(),
		StartedAt: time.Now(),
	}
	s.touch()
	return s
}

func (s *StreamSession) touch() { s.lastSeenUnix.Store(time.Now().UnixNano()) }

func (s *StreamSession) lastSeen() time.Time { return time.Unix(0, s.lastSeenUnix.Load()) }

// --- Audio Streaming Service ---

// StreamingService handles audio delivery with CDN integration.
type StreamingService struct {
	catalog     CatalogService
	cdn         CDNService
	mu          sync.RWMutex
	sessions    map[string]*StreamSession
	playEventCh chan PlayEvent

	// Metrics
	activeStreams  atomic.Int64
	totalSegments  atomic.Int64
	totalBytes     atomic.Int64
	droppedEvents  atomic.Int64
	expiredSession atomic.Int64
}

// Metrics snapshots the service counters.
//
// Without an accessor these counters are write-only: incremented on every
// request, read by nothing, reported nowhere. A metric nobody can read is not
// a metric, it is a contended cache line.
type Metrics struct {
	ActiveStreams   int64
	TotalSegments   int64
	TotalBytes      int64
	DroppedEvents   int64
	ExpiredSessions int64
}

func (ss *StreamingService) Metrics() Metrics {
	return Metrics{
		ActiveStreams:   ss.activeStreams.Load(),
		TotalSegments:   ss.totalSegments.Load(),
		TotalBytes:      ss.totalBytes.Load(),
		DroppedEvents:   ss.droppedEvents.Load(),
		ExpiredSessions: ss.expiredSession.Load(),
	}
}

// CatalogService provides track metadata and manifests.
type CatalogService interface {
	GetManifest(ctx context.Context, trackID string) (*TrackManifest, error)
	GetSegment(ctx context.Context, trackID string, segIdx int, quality AudioQuality) (*AudioSegment, error)
}

// CDNService handles CDN URL signing and cache management.
type CDNService interface {
	GetSignedURL(fileID string, expiry time.Duration) (string, error)
	PrefetchSegments(ctx context.Context, trackID string, fromSeg, count int, quality AudioQuality) error
}

// PlayEvent records a segment play for analytics and royalty calculation.
type PlayEvent struct {
	UserID     string
	TrackID    string
	SegmentIdx int
	Quality    AudioQuality
	DurationMs int64
	Timestamp  time.Time
}

func NewStreamingService(catalog CatalogService, cdn CDNService) *StreamingService {
	return &StreamingService{
		catalog:     catalog,
		cdn:         cdn,
		sessions:    make(map[string]*StreamSession),
		playEventCh: make(chan PlayEvent, 100000),
	}
}

// StartStream initializes a new streaming session for a track. The entitlement
// is resolved once here, at the one point that knows both the account and the
// client's declared output path, and the resulting ladder is frozen onto the
// session so no later segment request can widen it.
func (ss *StreamingService) StartStream(ctx context.Context, userID, trackID, sessionID string, ent Entitlement) (*StreamSession, error) {
	manifest, err := ss.catalog.GetManifest(ctx, trackID)
	if err != nil {
		return nil, fmt.Errorf("get manifest: %w", err)
	}

	session := NewStreamSession(sessionID, userID, manifest)
	session.Allowed = AvailableQualities(manifest.Qualities, ent)

	ss.mu.Lock()
	ss.sessions[sessionID] = session
	ss.mu.Unlock()
	ss.activeStreams.Add(1)

	// Warm the first few segments. Best-effort: a prefetch failure costs a
	// slower first segment, not a broken stream, so log and continue.
	q := session.Bitrate.CurrentQuality()
	if err := ss.cdn.PrefetchSegments(ctx, trackID, 0, 3, q); err != nil {
		log.Printf("prefetch %s seg 0-2 at %s: %v", trackID, q, err)
	}

	return session, nil
}

// ReapExpiredSessions removes sessions that have gone quiet.
//
// EndStream is the happy path, and the happy path is not the common one at this
// scale. Clients lose signal, get force-quit, and drive into tunnels, and none
// of those send a goodbye. Without a reaper the sessions map is an unbounded
// memory leak and activeStreams climbs forever, eventually reading as though
// every user who ever pressed play is still listening.
func (ss *StreamingService) ReapExpiredSessions(idleFor time.Duration) {
	cutoff := time.Now().Add(-idleFor)

	ss.mu.Lock()
	defer ss.mu.Unlock()
	for id, sess := range ss.sessions {
		if sess.lastSeen().Before(cutoff) {
			delete(ss.sessions, id)
			ss.activeStreams.Add(-1)
			ss.expiredSession.Add(1)
		}
	}
}

// RunReaper drives ReapExpiredSessions until ctx is cancelled.
func (ss *StreamingService) RunReaper(ctx context.Context, every, idleFor time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return // bounded lifetime: no goroutine outlives the service
		case <-t.C:
			ss.ReapExpiredSessions(idleFor)
		}
	}
}

// ServeSegment handles an HTTP request for a specific audio segment.
func (ss *StreamingService) ServeSegment(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session")

	// Validate the index. Atoi's error is not noise: without the check, any
	// garbage becomes segment 0 and a negative value indexes out of range.
	segIdx, err := strconv.Atoi(r.URL.Query().Get("segment"))
	if err != nil || segIdx < 0 {
		http.Error(w, "bad segment index", http.StatusBadRequest)
		return
	}

	ss.mu.RLock()
	session, exists := ss.sessions[sessionID]
	ss.mu.RUnlock()
	if !exists {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	session.touch()

	if segIdx >= session.Manifest.Segments {
		http.Error(w, "segment past end of track", http.StatusNotFound)
		return
	}

	// The client measures its own link and reports it. See the note above on
	// why the server timing its own CDN fetch would measure the wrong network.
	if bufStr := r.Header.Get("X-Buffer-Level-Ms"); bufStr != "" {
		if bufMs, err := strconv.ParseInt(bufStr, 10, 64); err == nil {
			session.Bitrate.UpdateBufferLevel(bufMs)
		}
	}
	if s, d := r.Header.Get("X-Last-Segment-Bytes"), r.Header.Get("X-Last-Segment-Ms"); s != "" && d != "" {
		bytes, errB := strconv.ParseInt(s, 10, 64)
		ms, errD := strconv.ParseInt(d, 10, 64)
		if errB == nil && errD == nil {
			session.Bitrate.RecordClientSample(bytes, ms)
		}
	}

	quality := session.Bitrate.SelectQuality(session.Allowed)

	segment, err := ss.catalog.GetSegment(r.Context(), session.TrackID, segIdx, quality)
	if err != nil {
		http.Error(w, "segment unavailable", http.StatusInternalServerError)
		return
	}

	// Look-ahead prefetch, detached from the request context: r.Context() is
	// cancelled as soon as this response is written, which would abort the very
	// prefetch we are trying to warm.
	if segIdx+3 < session.Manifest.Segments {
		go func() {
			pctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			defer cancel()
			if err := ss.cdn.PrefetchSegments(pctx, session.TrackID, segIdx+1, 3, quality); err != nil {
				log.Printf("prefetch %s seg %d: %v", session.TrackID, segIdx+1, err)
			}
		}()
	}

	// Content-Length comes from the bytes we are about to write, never from a
	// separate size field. If the two ever disagree the client hangs waiting
	// for bytes that are not coming, or truncates the segment.
	w.Header().Set("Content-Type", quality.ContentType())
	w.Header().Set("Content-Length", strconv.Itoa(len(segment.Data)))
	w.Header().Set("X-Segment-Duration-Ms", strconv.FormatInt(segment.DurationMs, 10))
	w.Header().Set("X-Quality", quality.String())
	w.Header().Set("Cache-Control", "private, max-age=3600")

	n, err := w.Write(segment.Data)
	if err != nil {
		// Client hung up mid-segment. Do not bill a play for bytes that never
		// landed, and do not count them as delivered.
		log.Printf("write segment %s/%d: %v", session.TrackID, segIdx, err)
		return
	}

	session.SegmentsServed.Add(1)
	session.BytesStreamed.Add(int64(n))
	ss.totalSegments.Add(1)
	ss.totalBytes.Add(int64(n))

	// Non-blocking send. A blocking send on a full channel parks this handler
	// indefinitely while holding a connection, so one stalled consumer would
	// take down the whole streaming tier. Shedding a telemetry event is the
	// correct trade against dropping the stream, and the counter makes the loss
	// visible rather than silent.
	select {
	case ss.playEventCh <- PlayEvent{
		UserID:     session.UserID,
		TrackID:    session.TrackID,
		SegmentIdx: segIdx,
		Quality:    quality,
		DurationMs: segment.DurationMs,
		Timestamp:  time.Now(),
	}:
	default:
		ss.droppedEvents.Add(1)
	}
}

// EndStream cleans up a streaming session.
func (ss *StreamingService) EndStream(sessionID string) {
	ss.mu.Lock()
	_, existed := ss.sessions[sessionID]
	delete(ss.sessions, sessionID)
	ss.mu.Unlock()

	// Only decrement if we actually removed something. A duplicate EndStream,
	// or one racing the reaper, would otherwise drive activeStreams negative.
	if existed {
		ss.activeStreams.Add(-1)
	}
}

// HandleGaplessTransition prepares the next track for gapless playback.
// The client requests the next track's first segments before the current track ends.
func (ss *StreamingService) HandleGaplessTransition(ctx context.Context, sessionID, nextTrackID string) (*TrackManifest, error) {
	ss.mu.RLock()
	session, exists := ss.sessions[sessionID]
	ss.mu.RUnlock()
	if !exists {
		return nil, fmt.Errorf("session not found")
	}

	nextManifest, err := ss.catalog.GetManifest(ctx, nextTrackID)
	if err != nil {
		return nil, err
	}

	// Prefetch at the tier the controller has actually converged on, clamped to
	// what the next track offers, since two tracks need not share a ladder.
	q := clampQuality(session.Bitrate.CurrentQuality(), nextManifest.Qualities)
	if err := ss.cdn.PrefetchSegments(ctx, nextTrackID, 0, 3, q); err != nil {
		log.Printf("gapless prefetch %s: %v", nextTrackID, err)
	}

	return nextManifest, nil
}

// PlayEvents returns the channel to consume play events for royalty calculation.
func (ss *StreamingService) PlayEvents() <-chan PlayEvent {
	return ss.playEventCh
}

// --- CDN URL Signer ---

type CDNURLSigner struct {
	baseURL   string
	secretKey []byte
}

// GetSignedURL issues an expiring, tamper-evident URL for one CDN object.
//
// The signature covers the expiry as well as the file ID. Signing only the file
// ID would let anyone edit expires= to any value they liked and hold a
// permanent link, which defeats the entire purpose of an expiring URL: the
// parameter you are trying to enforce is the one that has to be authenticated.
func (s *CDNURLSigner) GetSignedURL(fileID string, expiry time.Duration) (string, error) {
	if len(s.secretKey) == 0 {
		// Fail loudly. A signer with no key that returns a plausible URL is
		// worse than one that errors: it publishes an open door.
		return "", fmt.Errorf("cdn signer: no secret key configured")
	}
	expires := time.Now().Add(expiry).Unix()

	mac := hmac.New(sha256.New, s.secretKey)
	fmt.Fprintf(mac, "%s:%d", fileID, expires)
	sig := hex.EncodeToString(mac.Sum(nil))

	return fmt.Sprintf("%s/%s?expires=%d&sig=%s", s.baseURL, fileID, expires, sig), nil
}

// VerifySignedURL is what the edge runs. Included because the verify side is
// where signed URLs are usually broken.
func (s *CDNURLSigner) VerifySignedURL(fileID string, expires int64, sig string) error {
	if time.Now().Unix() > expires {
		return fmt.Errorf("url expired")
	}
	mac := hmac.New(sha256.New, s.secretKey)
	fmt.Fprintf(mac, "%s:%d", fileID, expires)
	want := mac.Sum(nil)

	got, err := hex.DecodeString(sig)
	if err != nil {
		return fmt.Errorf("bad signature encoding")
	}
	// Constant time. A plain == on the bytes leaks how much of the signature
	// was correct through its timing, which is enough to forge one byte at a
	// time. Never compare a MAC with bytes.Equal or ==.
	if !hmac.Equal(got, want) {
		return fmt.Errorf("bad signature")
	}
	return nil
}
```

---
