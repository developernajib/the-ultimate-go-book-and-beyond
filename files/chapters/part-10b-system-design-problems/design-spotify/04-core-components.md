## Core Components

### 1. Audio Delivery Service

The Audio Delivery Service generates pre-signed S3 URLs that give the client direct access to audio segments stored in object storage, avoiding the need to proxy gigabytes of audio through the API tier. Each track is stored in multiple quality tiers (96 kbps, 160 kbps, and 320 kbps Ogg Vorbis, plus lossless FLAC at up to 24-bit/44.1 kHz) so the client can request the appropriate bitrate based on the user's subscription and network conditions. Play events are published to Kafka asynchronously so that every qualifying stream can be counted for royalty calculations without adding latency to the streaming request.

Note that the container is a property of the tier rather than a free parameter. Three of the four tiers are Ogg and the fourth is FLAC, so a request that names a quality has already named its extension. The `Format` field on the request survives for podcasts and legacy clients, but it cannot be allowed to override the tier's own container.

```go
package streaming

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Track struct {
	ID              string
	DurationSeconds int
	HasDRM          bool
}

type User struct {
	ID        string
	IsPremium bool
}

type CatalogService interface {
	GetTrack(ctx context.Context, trackID string) (*Track, error)
}

type UserService interface {
	GetUser(ctx context.Context, userID string) (*User, error)
}

type PlayEventProducer interface {
	RecordStreamStart(ctx context.Context, event PlayEvent) error
	RecordPlay(ctx context.Context, event PlayEvent) error
}

// StreamingService handles audio delivery
type StreamingService struct {
	s3Presign  *s3.PresignClient
	bucket     string
	cdnBaseURL string
	catalog    CatalogService
	userSvc    UserService
	playEvents PlayEventProducer
}

// Quality represents audio bitrate
type Quality string

const (
	QualityLow      Quality = "low"      // 96 kbps Ogg Vorbis
	QualityNormal   Quality = "normal"   // 160 kbps Ogg Vorbis
	QualityHigh     Quality = "high"     // 320 kbps Ogg Vorbis, premium only
	QualityLossless Quality = "lossless" // FLAC up to 24-bit/44.1kHz, premium only
)

// ext maps a tier to its container. Lossless is FLAC and everything else is
// Ogg, so this is the one place that knows it and the only way to build a key.
func (q Quality) ext() string {
	if q == QualityLossless {
		return "flac"
	}
	return "ogg"
}

// StreamRequest is a client's request to stream a track.
//
// There is no Format field. The container is a function of the quality tier
// (Ogg for the lossy rungs, FLAC for lossless), so letting the client name a
// format independently only creates combinations that do not exist on disk.
type StreamRequest struct {
	TrackID string  `json:"track_id"`
	Quality Quality `json:"quality"`
	UserID  string  `json:"user_id"`

	// LosslessEligible is the client asserting that the user enabled lossless
	// on this device and that the current output path can carry it. The server
	// cannot see the headphone jack or the Bluetooth stack, so it has to be
	// told. Entitlement is still checked here against the subscription: this
	// flag can only ever narrow what the account already permits.
	LosslessEligible bool `json:"lossless_eligible"`
}

// StreamResponse returns CDN URLs for audio delivery
type StreamResponse struct {
	TrackID    string          `json:"track_id"`
	StreamURLs []StreamSegment `json:"stream_urls"`
	Duration   int             `json:"duration_seconds"`
	Format     string          `json:"format"`
	ExpiresAt  time.Time       `json:"expires_at"`
}

// StreamSegment is a pre-signed URL for one audio segment
type StreamSegment struct {
	Sequence int    `json:"seq"`
	URL      string `json:"url"`
	Duration int    `json:"duration_seconds"` // segment duration
}

// GetStreamURL generates delivery URLs for a track
func (s *StreamingService) GetStreamURL(ctx context.Context, req StreamRequest) (*StreamResponse, error) {
	// Check user's subscription for quality limits
	user, err := s.userSvc.GetUser(ctx, req.UserID)
	if err != nil {
		return nil, err
	}

	// Free accounts cap at 160 kbps. Both paid rungs collapse to the same
	// ceiling, so this is one rule and not a chain of special cases.
	quality := req.Quality
	if !user.IsPremium && (quality == QualityHigh || quality == QualityLossless) {
		quality = QualityNormal
	}
	// Lossless is Premium, but Premium alone does not earn it. The client has
	// to have opted in on this device and to have an output path that carries
	// the bits intact, and only the client knows either. Serving FLAC to a
	// phone that will re-encode it over Bluetooth costs eight times the bytes
	// to deliver something audibly identical to the 320 kbps rung.
	if quality == QualityLossless && !req.LosslessEligible {
		quality = QualityHigh
	}

	// Get track metadata
	track, err := s.catalog.GetTrack(ctx, req.TrackID)
	if err != nil {
		return nil, fmt.Errorf("track not found: %w", err)
	}

	// The container follows the tier that survived the checks above, not the
	// tier the client asked for. Deriving it after the downgrade is what keeps
	// a demoted lossless request from being handed .flac keys that hold Ogg.
	format := quality.ext()

	// Generate CDN URLs for each segment
	// In production: audio is pre-segmented into 10-second chunks (like HLS but for audio)
	segments := track.DurationSeconds / 10
	if track.DurationSeconds%10 > 0 {
		segments++
	}

	streamSegments := make([]StreamSegment, segments)
	for i := 0; i < segments; i++ {
		segKey := s3Key(req.TrackID, quality, i)

		// Use CDN URL directly (no presigning for public CDN-cached content)
		// For DRM content: presigned URL with short TTL
		var url string
		if track.HasDRM {
			presigned, err := s.s3Presign.PresignGetObject(ctx, &s3.GetObjectInput{
				Bucket: aws.String(s.bucket),
				Key:    aws.String(segKey),
			}, s3.WithPresignExpires(1*time.Hour))
			if err != nil {
				return nil, err
			}
			url = presigned.URL
		} else {
			url = fmt.Sprintf("%s/%s", s.cdnBaseURL, segKey)
		}

		streamSegments[i] = StreamSegment{
			Sequence: i,
			URL:      url,
			Duration: 10,
		}
	}

	// Record stream start event off the request path. The request context is
	// cancelled the moment the response is written, so detach from cancellation
	// while keeping its values (trace IDs, tenant) and give the publish its own
	// deadline. Passing ctx straight into the goroutine would drop most events.
	evCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	go func() {
		defer cancel()
		if err := s.playEvents.RecordStreamStart(evCtx, PlayEvent{
			TrackID:   req.TrackID,
			UserID:    req.UserID,
			Quality:   string(quality),
			Format:    format,
			Timestamp: time.Now(),
		}); err != nil {
			// Stream-start is a telemetry signal, not the billable play event,
			// so log and move on rather than failing the stream.
			log.Printf("record stream start: track=%s: %v", req.TrackID, err)
		}
	}()

	return &StreamResponse{
		TrackID:    req.TrackID,
		StreamURLs: streamSegments,
		Duration:   track.DurationSeconds,
		Format:     format,
		ExpiresAt:  time.Now().Add(1 * time.Hour),
	}, nil
}

// RecordPlay records a complete play event (for recommendations and royalties)
func (s *StreamingService) RecordPlay(ctx context.Context, userID, trackID string, listenedSeconds int) error {
	// Must have listened at least 30 seconds to count as a "play" for royalties
	isFullPlay := listenedSeconds >= 30

	// This one is money, so the error propagates. The caller retries and the
	// downstream royalty pipeline deduplicates on (user, track, timestamp).
	return s.playEvents.RecordPlay(ctx, PlayEvent{
		TrackID:         trackID,
		UserID:          userID,
		ListenedSeconds: listenedSeconds,
		IsCountedPlay:   isFullPlay,
		Timestamp:       time.Now(),
	})
}

// GetDownloadURL generates a pre-signed download URL for offline use
func (s *StreamingService) GetDownloadURL(ctx context.Context, userID, trackID string, quality Quality) (string, error) {
	user, err := s.userSvc.GetUser(ctx, userID)
	if err != nil {
		// Do not collapse a lookup failure into "not premium". A user service
		// outage would otherwise look like a downgrade to every paying member.
		return "", fmt.Errorf("lookup user %s: %w", userID, err)
	}
	if !user.IsPremium {
		return "", fmt.Errorf("offline downloads require premium subscription")
	}

	key := s3Key(trackID, quality, -1) // -1 = full file
	presigned, err := s.s3Presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(24*time.Hour))
	if err != nil {
		return "", err
	}
	return presigned.URL, nil
}

// s3Key builds the object key for one segment, or the full file when segment
// is -1. The extension comes from the tier rather than from a caller-supplied
// string: this key layout is the contract the transcoder writes against, and
// the two agreeing is the only reason any of this resolves.
func s3Key(trackID string, quality Quality, segment int) string {
	if segment == -1 {
		return fmt.Sprintf("audio/%s/%s/%s.%s", trackID, quality, trackID, quality.ext())
	}
	return fmt.Sprintf("audio/%s/%s/seg_%04d.%s", trackID, quality, segment, quality.ext())
}

type PlayEvent struct {
	TrackID         string
	UserID          string
	Quality         string
	Format          string
	ListenedSeconds int
	IsCountedPlay   bool
	Timestamp       time.Time
}
```

### 2. Catalog Service (Search)

The Catalog Service is the music metadata layer, managing all track, artist, and album records and providing full-text search over the 80+ million track library. It uses Elasticsearch's multi-match query across title, artist name, and album fields, with the popularity score blended into the relevance ranking so that well-known tracks surface above obscure matches for ambiguous queries. The `explicit` filter and DRM flags allow the service to respect both parental control settings and regional licensing restrictions at query time.

```go
package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/elastic/go-elasticsearch/v8"
)

// CatalogService manages music metadata and search
type CatalogService struct {
	esClient *elasticsearch.Client
}

// Track is song metadata
type Track struct {
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	ArtistIDs       []string `json:"artist_ids"`
	ArtistNames     []string `json:"artist_names"`
	AlbumID         string   `json:"album_id"`
	AlbumName       string   `json:"album_name"`
	DurationSeconds int      `json:"duration_seconds"`
	Genres          []string `json:"genres"`
	Popularity      float64  `json:"popularity"`  // 0-100 based on play count
	ReleaseDate     string   `json:"release_date"`
	Explicit        bool     `json:"explicit"`
	HasDRM          bool     `json:"has_drm"`
	ThumbnailURL    string   `json:"thumbnail_url"`
}

// SearchRequest for music search
type SearchRequest struct {
	Query           string   `json:"query"`
	Types           []string `json:"types"` // track, artist, album, playlist, podcast
	Limit           int      `json:"limit"`
	Offset          int      `json:"offset"`
	ExcludeExplicit bool     `json:"exclude_explicit"`
}

// SearchResult contains mixed results
type SearchResult struct {
	Tracks    []Track  `json:"tracks"`
	Artists   []Artist `json:"artists"`
	Albums    []Album  `json:"albums"`
	TotalHits int      `json:"total_hits"`
}

// Search performs unified music search
func (s *CatalogService) Search(ctx context.Context, req SearchRequest) (*SearchResult, error) {
	if req.Limit == 0 {
		req.Limit = 20
	}

	// Multi-index search across tracks, artists, albums
	indices := "tracks,artists,albums"
	if len(req.Types) > 0 {
		indices = strings.Join(req.Types, ",")
	}

	query := s.buildSearchQuery(req)

	res, err := s.esClient.Search(
		s.esClient.Search.WithContext(ctx),
		s.esClient.Search.WithIndex(indices),
		s.esClient.Search.WithBody(strings.NewReader(query)),
	)
	if err != nil {
		return nil, fmt.Errorf("es search: %w", err)
	}
	defer res.Body.Close()

	// The Go client only returns a transport error here. A 4xx or 5xx from
	// Elasticsearch arrives as a normal response with IsError set, so an
	// unchecked call happily parses an error document into zero hits.
	if res.IsError() {
		return nil, fmt.Errorf("es search: %s", res.Status())
	}

	return s.parseSearchResults(res.Body)
}

func (s *CatalogService) buildSearchQuery(req SearchRequest) string {
	must := []map[string]any{
		{
			"multi_match": map[string]any{
				"query":  req.Query,
				"fields": []string{"title^3", "artist_names^2", "album_name", "genres"},
				"type":   "best_fields",
				"fuzziness": "AUTO",
			},
		},
	}

	filter := []map[string]any{}
	if req.ExcludeExplicit {
		filter = append(filter, map[string]any{
			"term": map[string]any{"explicit": false},
		})
	}

	query := map[string]any{
		"query": map[string]any{
			"bool": map[string]any{
				"must":   must,
				"filter": filter,
			},
		},
		"sort": []map[string]any{
			{"_score": map[string]any{"order": "desc"}},
			{"popularity": map[string]any{"order": "desc"}},
		},
		"from": req.Offset,
		"size": req.Limit,
	}

	b, _ := json.Marshal(query)
	return string(b)
}

// parseSearchResults demultiplexes a multi-index response. Every hit carries
// the index it came from, which is how one query feeds three typed slices.
func (s *CatalogService) parseSearchResults(body io.Reader) (*SearchResult, error) {
	var raw struct {
		Hits struct {
			Total struct {
				Value int `json:"value"`
			} `json:"total"`
			Hits []struct {
				Index  string          `json:"_index"`
				Source json.RawMessage `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.NewDecoder(body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode es response: %w", err)
	}

	out := &SearchResult{TotalHits: raw.Hits.Total.Value}
	for _, h := range raw.Hits.Hits {
		switch h.Index {
		case "tracks":
			var t Track
			if err := json.Unmarshal(h.Source, &t); err != nil {
				return nil, fmt.Errorf("decode track hit: %w", err)
			}
			out.Tracks = append(out.Tracks, t)
		case "artists":
			var a Artist
			if err := json.Unmarshal(h.Source, &a); err != nil {
				return nil, fmt.Errorf("decode artist hit: %w", err)
			}
			out.Artists = append(out.Artists, a)
		case "albums":
			var a Album
			if err := json.Unmarshal(h.Source, &a); err != nil {
				return nil, fmt.Errorf("decode album hit: %w", err)
			}
			out.Albums = append(out.Albums, a)
		}
	}
	return out, nil
}

// GetTrack retrieves track metadata by ID
func (s *CatalogService) GetTrack(ctx context.Context, trackID string) (*Track, error) {
	res, err := s.esClient.Get(
		"tracks",
		trackID,
		s.esClient.Get.WithContext(ctx),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.IsError() {
		// Without this a 404 decodes into a zero-valued Track, and the caller
		// streams a track with no duration and no DRM flag.
		return nil, fmt.Errorf("get track %s: %s", trackID, res.Status())
	}

	var result struct {
		Source Track `json:"_source"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result.Source, nil
}

type Artist struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Genres       []string `json:"genres"`
	Followers    int      `json:"followers"`
	Popularity   float64  `json:"popularity"`
	ThumbnailURL string   `json:"thumbnail_url"`
}

type Album struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	ArtistID    string `json:"artist_id"`
	ArtistName  string `json:"artist_name"`
	ReleaseDate string `json:"release_date"`
	TrackCount  int    `json:"track_count"`
	CoverURL    string `json:"cover_url"`
}
```

### 3. Recommendation Engine

The Recommendation Engine personalizes track suggestions using 128-dimensional embeddings produced by an offline Spark job. The embeddings come from collaborative filtering: factorize the sparse user-by-track play matrix and you get a user vector and a track vector in the same latent space, so cosine similarity between them is a preference score. Nothing in those dimensions is human-interpretable. They are whatever the factorization found, which is why the model can group tracks that share no genre tag but share an audience. Spotify has described exactly this ensemble publicly for Discover Weekly: collaborative filtering as the backbone, plus NLP over text written about music and a convolutional model over raw audio to cover tracks with too few plays to place in the matrix.

That last piece is the cold-start problem, and it cuts both ways. A brand-new track has no plays, so collaborative filtering cannot place it and audio content analysis fills the gap. A brand-new user has no history, so there is no vector to look up at all, and this service falls back to the global popularity chart while the pipeline accumulates signal. Popularity is a weak recommendation, but it beats an empty screen and it starts generating the plays the model needs.

```go
package recommendation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type CatalogService interface{}

// RecommendationService generates personalized music recommendations
type RecommendationService struct {
	rdb     *redis.Client
	catalog CatalogService
}

// UserVector is a user's learned taste embedding: the user-side factor from
// collaborative filtering, in the same latent space as TrackFeature.Vector.
type UserVector struct {
	UserID    string    `json:"user_id"`
	Vector    []float64 `json:"vector"` // 128-dim latent factor
	UpdatedAt time.Time `json:"updated_at"`
}

// TrackFeature is a track's audio feature vector (from ML model)
type TrackFeature struct {
	TrackID          string    `json:"track_id"`
	Vector           []float64 `json:"vector"` // 128-dim embedding
	Acousticness     float64   `json:"acousticness"` // 0-1
	Danceability     float64   `json:"danceability"` // 0-1
	Energy           float64   `json:"energy"`       // 0-1
	Instrumentalness float64   `json:"instrumentalness"`
	Valence          float64   `json:"valence"` // mood: 0=sad, 1=happy
	Tempo            float64   `json:"tempo"`   // BPM
}

// GetRecommendations returns personalized track recommendations
func (s *RecommendationService) GetRecommendations(ctx context.Context, userID string, limit int) ([]string, error) {
	// Get user's taste vector (precomputed by the nightly Spark job)
	userVec, err := s.getUserVector(ctx, userID)
	switch {
	case errors.Is(err, redis.Nil):
		// No vector yet: a genuinely new user. Serve the popularity chart.
		return s.getPopularTracks(ctx, limit)
	case err != nil:
		// A Redis failure is not a cold-start user. Degrade to the same chart
		// so the shelf still renders, but log it so the outage is visible
		// instead of masquerading as a surge of brand-new listeners.
		log.Printf("recs: user vector lookup failed for %s, serving chart: %v", userID, err)
		return s.getPopularTracks(ctx, limit)
	}

	// Get candidate tracks (nearest neighbors in vector space)
	// In production: use Spotify's Annoy library for approximate nearest neighbor
	candidates, err := s.findSimilarTracks(ctx, userVec.Vector, limit*5)
	if err != nil {
		return nil, err
	}

	// Filter out recently played tracks
	recentlyPlayed, _ := s.getRecentlyPlayed(ctx, userID, 200)
	recentSet := make(map[string]bool)
	for _, id := range recentlyPlayed {
		recentSet[id] = true
	}

	var filtered []string
	for _, trackID := range candidates {
		if !recentSet[trackID] {
			filtered = append(filtered, trackID)
		}
		if len(filtered) >= limit {
			break
		}
	}

	return filtered, nil
}

// getUserVector retrieves a user's taste embedding
func (s *RecommendationService) getUserVector(ctx context.Context, userID string) (*UserVector, error) {
	key := fmt.Sprintf("user:vector:%s", userID)
	data, err := s.rdb.Get(ctx, key).Bytes()
	if err != nil {
		return nil, err
	}
	var vec UserVector
	if err := json.Unmarshal(data, &vec); err != nil {
		return nil, err
	}
	return &vec, nil
}

// findSimilarTracks ranks tracks against a user vector by cosine similarity.
//
// Read this as an illustration of the scoring step, not as the serving path.
// Scanning every track vector is O(catalog) per request: at 80M tracks that is
// 80M round trips and 80M dot products to answer one recommendation call.
// Production serving replaces this whole function with an approximate nearest
// neighbor index (Annoy, which Spotify open sourced, or FAISS) that answers in
// sublinear time, and the ANN query itself usually runs over a candidate set
// narrowed offline rather than the full catalog.
func (s *RecommendationService) findSimilarTracks(ctx context.Context, userVec []float64, limit int) ([]string, error) {
	type scored struct {
		trackID string
		score   float64
	}
	var candidates []scored

	// SCAN, never KEYS. KEYS walks the entire keyspace in one shot and blocks
	// the single Redis thread for the duration, stalling every other client.
	iter := s.rdb.Scan(ctx, 0, "track:vector:*", 1000).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		data, err := s.rdb.Get(ctx, key).Bytes()
		if err != nil {
			continue
		}
		var feat TrackFeature
		if err := json.Unmarshal(data, &feat); err != nil {
			continue
		}

		sim := cosineSimilarity(userVec, feat.Vector)
		trackID := strings.TrimPrefix(key, "track:vector:")
		candidates = append(candidates, scored{trackID: trackID, score: sim})
	}
	if err := iter.Err(); err != nil {
		return nil, fmt.Errorf("scan track vectors: %w", err)
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})

	result := make([]string, 0, limit)
	for i, c := range candidates {
		if i >= limit {
			break
		}
		result = append(result, c.trackID)
	}
	return result, nil
}

// cosineSimilarity computes cosine similarity between two vectors
func cosineSimilarity(a, b []float64) float64 {
	if len(a) != len(b) {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

func (s *RecommendationService) getRecentlyPlayed(ctx context.Context, userID string, limit int) ([]string, error) {
	key := fmt.Sprintf("user:played:%s", userID)
	return s.rdb.LRange(ctx, key, 0, int64(limit-1)).Result()
}

func (s *RecommendationService) getPopularTracks(ctx context.Context, limit int) ([]string, error) {
	// Get top tracks by global play count (updated hourly)
	members, err := s.rdb.ZRevRange(ctx, "tracks:popular", 0, int64(limit-1)).Result()
	return members, err
}

// UpdateUserVector updates user's taste vector from play history
// Called by Spark batch job (runs nightly)
func (s *RecommendationService) UpdateUserVector(ctx context.Context, userID string, vector []float64) error {
	uv := UserVector{
		UserID:    userID,
		Vector:    vector,
		UpdatedAt: time.Now(),
	}
	data, _ := json.Marshal(uv)
	return s.rdb.Set(ctx, fmt.Sprintf("user:vector:%s", userID), data, 7*24*time.Hour).Err()
}
```

### 4. Playlist Service

The Playlist Service manages user-created and collaborative playlists stored in PostgreSQL, supporting ordered track lists with explicit integer position values rather than linked lists or timestamps. Adding a track places it after the current maximum position so new tracks land at the end.

Two details in this code are worth more attention than they look. First, the insert computes the next position inside the `INSERT ... SELECT` rather than reading the maximum in one query and writing it back in another. Two people adding to a shared playlist in the same instant would otherwise both read position 40 and both write position 41, and the playlist would have a stable but arbitrary tie order. Second, `canEdit` validates against the owner ID and a separate `playlist_collaborators` table. Trusting the `is_collaborative` flag alone would mean any user in the world can edit any playlist that has ever been shared, because the flag says the playlist accepts collaborators, not that this particular user is one of them.

```go
package playlist

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Track struct {
	DurationSeconds int
}

type CatalogService interface {
	GetTrack(ctx context.Context, trackID string) (*Track, error)
}

// PlaylistService manages user playlists
type PlaylistService struct {
	db      *pgxpool.Pool
	catalog CatalogService // for track duration when maintaining rollups
}

// Playlist is a user's collection of tracks
type Playlist struct {
	ID          string    `json:"id"`
	OwnerID     string    `json:"owner_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	IsPublic    bool      `json:"is_public"`
	IsCollaborative bool  `json:"is_collaborative"`
	TrackCount  int       `json:"track_count"`
	Duration    int       `json:"duration_seconds"`
	Followers   int       `json:"followers"`
	CoverURL    string    `json:"cover_url"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// AddTrack adds a track to the end of a playlist.
func (s *PlaylistService) AddTrack(ctx context.Context, playlistID, userID, trackID string) error {
	ok, err := s.canEdit(ctx, playlistID, userID)
	if err != nil {
		return fmt.Errorf("check edit permission: %w", err)
	}
	if !ok {
		return fmt.Errorf("permission denied")
	}

	// Resolve the duration before opening the transaction. A catalog call is a
	// network hop, and holding a row lock across one is how you turn a slow
	// dependency into database-wide lock contention.
	track, err := s.catalog.GetTrack(ctx, trackID)
	if err != nil {
		return fmt.Errorf("lookup track %s: %w", trackID, err)
	}

	// The insert and the counter bump have to agree, so run them in one
	// transaction. Otherwise a crash between them leaves track_count wrong
	// forever, and nothing ever recomputes it.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // no-op once Commit succeeds

	// Compute the next position in the same statement that inserts it. A
	// read-then-write would let concurrent adders pick the same position.
	tag, err := tx.Exec(ctx, `
		INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by, added_at)
		SELECT $1, $2, COALESCE(MAX(position), 0) + 1, $3, NOW()
		FROM playlist_tracks WHERE playlist_id = $1
		ON CONFLICT (playlist_id, track_id) DO NOTHING`,
		playlistID, trackID, userID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// The track was already in the playlist and ON CONFLICT swallowed the
		// insert. Bumping track_count here would inflate it on every duplicate
		// add until the number on screen has nothing to do with the rows.
		return tx.Commit(ctx)
	}

	// Keep the denormalized rollups in step with the rows we just wrote, so the
	// playlist header does not have to sum every track on read.
	if _, err := tx.Exec(ctx, `
		UPDATE playlists
		SET track_count = track_count + 1,
		    duration_seconds = duration_seconds + $2,
		    updated_at = NOW()
		WHERE id = $1`,
		playlistID, track.DurationSeconds,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetPlaylistTracks returns paginated tracks for a playlist
func (s *PlaylistService) GetPlaylistTracks(ctx context.Context, playlistID string, offset, limit int) ([]PlaylistTrack, error) {
	rows, err := s.db.Query(ctx, `
		SELECT pt.track_id, pt.position, pt.added_by, pt.added_at
		FROM playlist_tracks pt
		WHERE pt.playlist_id = $1
		ORDER BY pt.position ASC
		OFFSET $2 LIMIT $3`,
		playlistID, offset, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tracks []PlaylistTrack
	for rows.Next() {
		var t PlaylistTrack
		t.PlaylistID = playlistID
		if err := rows.Scan(&t.TrackID, &t.Position, &t.AddedBy, &t.AddedAt); err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	// rows.Err reports failures that ended the iteration early. Skip it and a
	// connection drop mid-scan returns a short playlist with no error at all.
	return tracks, rows.Err()
}

// canEdit answers whether userID may modify playlistID.
//
// The tempting version of this check is "owner, or the playlist is marked
// collaborative". That is an authorization hole, not a shortcut:
// is_collaborative says the playlist accepts collaborators, it does not say
// this user is one of them. Shipping it means any account can rewrite any
// shared playlist on the platform. Membership has to be proven against the
// collaborators table.
func (s *PlaylistService) canEdit(ctx context.Context, playlistID, userID string) (bool, error) {
	var allowed bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM playlists p
			WHERE p.id = $1 AND (
				p.owner_id = $2
				OR (p.is_collaborative AND EXISTS (
					SELECT 1 FROM playlist_collaborators c
					WHERE c.playlist_id = p.id AND c.user_id = $2
				))
			)
		)`,
		playlistID, userID,
	).Scan(&allowed)
	if err != nil {
		// Fail closed. An error here means we do not know whether this user is
		// allowed, and "do not know" must never resolve to "yes".
		return false, err
	}
	return allowed, nil
}

type PlaylistTrack struct {
	PlaylistID string
	TrackID    string
	Position   int
	AddedBy    string
	AddedAt    time.Time
}
```

---
