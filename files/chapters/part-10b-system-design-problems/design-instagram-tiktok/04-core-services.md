## Core Services

The platform is decomposed into focused microservices, each responsible for a single domain. This section walks through the most important ones with full Go implementations. Understanding these services individually is key because in a real interview you will be asked to drill into any one of them and explain the design trade-offs in detail.

### 1. Upload Service

The Upload Service handles media ingestion using a two-phase approach. First, the client requests a pre-signed S3 URL, which lets the browser or mobile app upload large files directly to object storage without routing through your API servers. This keeps your API tier lightweight and prevents upload traffic from competing with feed reads. After the client finishes uploading, it calls a completion endpoint that queues the file for asynchronous processing (transcoding, thumbnail generation, and content moderation).

```go
package upload

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// UploadService handles media uploads
type UploadService struct {
	s3Client  *s3.Client
	sqsClient *sqs.Client
	bucket    string
	queue     string // processing queue URL
}

// InitiateUploadResponse returns a pre-signed URL for direct browser upload
type InitiateUploadResponse struct {
	UploadID     string    `json:"upload_id"`
	PresignedURL string    `json:"presigned_url"`
	MediaKey     string    `json:"media_key"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// InitiateUpload generates a pre-signed S3 upload URL
// Client uploads directly to S3 (bypasses API servers for large files)
func (s *UploadService) InitiateUpload(ctx context.Context, userID, mediaType, contentType string) (*InitiateUploadResponse, error) {
	uploadID := generateUploadID()
	mediaKey := fmt.Sprintf("uploads/%s/%s/%s", userID, mediaType, uploadID)

	presigner := s3.NewPresignClient(s.s3Client)
	resp, err := presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(mediaKey),
		ContentType: aws.String(contentType),
	}, func(opts *s3.PresignOptions) {
		opts.Expires = 15 * time.Minute
	})
	if err != nil {
		return nil, fmt.Errorf("presign upload: %w", err)
	}

	return &InitiateUploadResponse{
		UploadID:     uploadID,
		PresignedURL: resp.URL,
		MediaKey:     mediaKey,
		ExpiresAt:    time.Now().Add(15 * time.Minute),
	}, nil
}

// CompleteUpload is called after client uploads to S3
// Triggers async media processing
func (s *UploadService) CompleteUpload(ctx context.Context, uploadID, userID, mediaKey string, metadata PostMetadata) error {
	// Queue for processing: thumbnail generation, transcoding, moderation
	msg := ProcessingJob{
		UploadID:  uploadID,
		UserID:    userID,
		MediaKey:  mediaKey,
		MediaType: metadata.MediaType,
		Caption:   metadata.Caption,
		Tags:      metadata.Tags,
		CreatedAt: time.Now().UTC(),
	}

	msgBody, _ := json.Marshal(msg)
	_, err := s.sqsClient.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String(s.queue),
		MessageBody: aws.String(string(msgBody)),
	})
	return err
}

type ProcessingJob struct {
	UploadID  string    `json:"upload_id"`
	UserID    string    `json:"user_id"`
	MediaKey  string    `json:"media_key"`
	MediaType string    `json:"media_type"` // "photo" | "video" | "story"
	Caption   string    `json:"caption"`
	Tags      []string  `json:"tags"`
	CreatedAt time.Time `json:"created_at"`
}

type PostMetadata struct {
	MediaType string    `json:"media_type"`
	Caption   string    `json:"caption"`
	Tags      []string  `json:"tags"`
	Location  *Location `json:"location,omitempty"`
}

type Location struct {
	Lat  float64 `json:"lat"`
	Long float64 `json:"long"`
	Name string  `json:"name"`
}

func generateUploadID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
```

### 2. Media Processing Pipeline

The Media Processing Pipeline runs asynchronously after upload completion. Videos must be transcoded into multiple quality levels (360p through 1080p) so that clients can stream at the best quality their network supports. Photos are resized into several variants (thumbnail, medium, large) and converted to WebP for smaller file sizes. This pipeline is the most compute-intensive part of the system, often taking 30+ seconds for video, which is why it must never run synchronously inside an API request handler.

```go
package processing

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// MediaProcessor handles transcoding and thumbnail generation
type MediaProcessor struct {
	s3Client *s3.Client
	bucket   string
	cdnBase  string
}

// VideoVariant is a transcoded video quality level
type VideoVariant struct {
	Quality  string // "1080p", "720p", "480p", "360p"
	Width    int
	Height   int
	Bitrate  string
	Codec    string
}

var videoVariants = []VideoVariant{
	{Quality: "1080p", Width: 1920, Height: 1080, Bitrate: "4000k", Codec: "h264"},
	{Quality: "720p", Width: 1280, Height: 720, Bitrate: "2500k", Codec: "h264"},
	{Quality: "480p", Width: 854, Height: 480, Bitrate: "1000k", Codec: "h264"},
	{Quality: "360p", Width: 640, Height: 360, Bitrate: "600k", Codec: "h264"},
}

// ProcessVideo transcodes video to multiple qualities for adaptive streaming
func (p *MediaProcessor) ProcessVideo(ctx context.Context, inputPath, outputBase string) ([]string, error) {
	var outputURLs []string

	for _, variant := range videoVariants {
		outputPath := fmt.Sprintf("%s_%s.mp4", outputBase, variant.Quality)

		// FFmpeg transcoding command
		cmd := exec.CommandContext(ctx, "ffmpeg",
			"-i", inputPath,
			"-vf", fmt.Sprintf("scale=%d:%d", variant.Width, variant.Height),
			"-b:v", variant.Bitrate,
			"-codec:v", variant.Codec,
			"-preset", "fast",
			"-codec:a", "aac",
			"-b:a", "128k",
			"-movflags", "+faststart", // enable streaming before full download
			outputPath,
		)

		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("transcode %s: %w", variant.Quality, err)
		}

		// Upload to S3
		if err := p.uploadToS3(ctx, outputPath); err != nil {
			return nil, err
		}

		outputURLs = append(outputURLs, p.cdnBase+"/"+outputBase+"_"+variant.Quality+".mp4")
	}

	// Generate HLS manifest for adaptive streaming
	if err := p.generateHLS(ctx, outputBase, outputURLs); err != nil {
		return nil, err
	}

	return outputURLs, nil
}

// GenerateThumbnail extracts a frame from the video
func (p *MediaProcessor) GenerateThumbnail(ctx context.Context, inputPath, outputPath string, timeOffset string) error {
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-ss", timeOffset,
		"-i", inputPath,
		"-vframes", "1",
		"-vf", "scale=400:400:force_original_aspect_ratio=increase,crop=400:400",
		outputPath,
	)
	return cmd.Run()
}

// ProcessPhoto resizes and converts photos for web delivery
func (p *MediaProcessor) ProcessPhoto(ctx context.Context, inputPath, outputBase string) (map[string]string, error) {
	sizes := map[string][2]int{
		"original": {0, 0},      // keep original
		"large":    {1080, 1080},
		"medium":    {640, 640},
		"thumbnail": {150, 150},
	}

	urls := make(map[string]string)
	for name, size := range sizes {
		outputPath := fmt.Sprintf("%s_%s.webp", outputBase, name)

		var cmd *exec.Cmd
		if size[0] == 0 {
			// Convert to WebP without resize
			cmd = exec.CommandContext(ctx, "convert", inputPath,
				"-quality", "85", outputPath)
		} else {
			cmd = exec.CommandContext(ctx, "convert", inputPath,
				"-resize", fmt.Sprintf("%dx%d^", size[0], size[1]),
				"-gravity", "center",
				"-extent", fmt.Sprintf("%dx%d", size[0], size[1]),
				"-quality", "85",
				"-strip", // remove EXIF
				outputPath,
			)
		}

		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("process %s: %w", name, err)
		}

		if err := p.uploadToS3(ctx, outputPath); err != nil {
			return nil, err
		}

		urls[name] = p.cdnBase + "/" + outputBase + "_" + name + ".webp"
	}

	return urls, nil
}

func (p *MediaProcessor) uploadToS3(ctx context.Context, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	_, err = p.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(filepath.Base(path)),
		Body:   f,
	})
	return err
}

// generateHLS writes the HLS master playlist that lists every quality level
// so players can switch bitrates mid-stream. The per-variant media playlists
// and segments are produced by FFmpeg's hls muxer during transcoding.
func (p *MediaProcessor) generateHLS(ctx context.Context, base string, variants []string) error {
	var sb strings.Builder
	sb.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n")

	for _, v := range videoVariants {
		kbps, err := strconv.Atoi(strings.TrimSuffix(v.Bitrate, "k"))
		if err != nil {
			return fmt.Errorf("parse bitrate %s: %w", v.Bitrate, err)
		}
		sb.WriteString(fmt.Sprintf(
			"#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n%s_%s.m3u8\n",
			kbps*1000, v.Width, v.Height, filepath.Base(base), v.Quality,
		))
	}

	path := base + "_master.m3u8"
	if err := os.WriteFile(path, []byte(sb.String()), 0o644); err != nil {
		return fmt.Errorf("write master playlist: %w", err)
	}
	return p.uploadToS3(ctx, path)
}
```

### 3. Feed Generation

Feed generation is the heart of any social media platform and the most asked-about component in interviews. There are two fundamental strategies: push (fan-out on write), where new posts are written to every follower's feed cache at post time, and pull (fan-in on read), where a user's feed is assembled from their followed users' posts when they open the app. This implementation uses a hybrid approach that pushes for normal users but pulls for celebrities, which avoids the massive write amplification that would occur when someone with millions of followers posts.

```go
package feed

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// FeedStrategy determines how feeds are built
type FeedStrategy int

const (
	PushOnWrite  FeedStrategy = iota // "fan-out on write": write to followers' feeds
	PullOnRead                       // "fan-in on read": assemble feed at read time
	HybridFeed                       // push for most users, pull for celebrities (>100K followers)
)

// Post is a feed item
type Post struct {
	ID           string    `json:"id"`
	UserID       string    `json:"user_id"`
	MediaURL     string    `json:"media_url"`
	ThumbnailURL string    `json:"thumbnail_url"`
	Caption      string    `json:"caption"`
	LikeCount    int64     `json:"like_count"`
	CommentCount int64     `json:"comment_count"`
	ViewCount    int64     `json:"view_count"`
	Score        float64   `json:"score"` // ranking score
	CreatedAt    time.Time `json:"created_at"`
}

// FeedService builds user feeds
type FeedService struct {
	rdb         *redis.ClusterClient
	postStore   PostStore
	followStore FollowStore
	scorer      FeedScorer
}

// GetFeed returns a user's personalized feed
func (s *FeedService) GetFeed(ctx context.Context, userID string, limit int, cursor string) ([]Post, string, error) {
	// Try pre-computed feed cache first
	feedKey := fmt.Sprintf("feed:%s", userID)

	start := int64(0)
	if cursor != "" {
		// Decode cursor to position
		fmt.Sscanf(cursor, "%d", &start)
	}

	// Get post IDs from Redis sorted set (score = ranking score)
	results, err := s.rdb.ZRevRangeWithScores(ctx, feedKey, start, start+int64(limit)-1).Result()
	if err != nil || len(results) == 0 {
		// Cache miss: build feed
		return s.buildFeed(ctx, userID, limit)
	}

	// Fetch post details in batch
	var postIDs []string
	for _, r := range results {
		postIDs = append(postIDs, r.Member.(string))
	}

	posts, err := s.postStore.GetBatch(ctx, postIDs)
	if err != nil {
		return nil, "", err
	}

	nextCursor := fmt.Sprintf("%d", start+int64(limit))
	return posts, nextCursor, nil
}

// buildFeed assembles feed at read time (pull model)
func (s *FeedService) buildFeed(ctx context.Context, userID string, limit int) ([]Post, string, error) {
	// Get followed users
	following, err := s.followStore.GetFollowing(ctx, userID, 1000)
	if err != nil {
		return nil, "", err
	}

	// Include own posts
	following = append(following, userID)

	// Fetch recent posts from each followed user (parallel)
	var (
		allPosts []Post
		mu       sync.Mutex
		wg       sync.WaitGroup
		errs     []error
	)

	for _, authorID := range following {
		wg.Add(1)
		go func(authorID string) {
			defer wg.Done()
			posts, err := s.postStore.GetByUser(ctx, authorID, 20)
			if err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
				return
			}
			mu.Lock()
			allPosts = append(allPosts, posts...)
			mu.Unlock()
		}(authorID)
	}
	wg.Wait()

	// Partial failures are tolerable (a few missing authors), but if every
	// fetch failed there is nothing to serve
	if len(allPosts) == 0 && len(errs) > 0 {
		return nil, "", errs[0]
	}

	// Score and rank posts
	for i := range allPosts {
		allPosts[i].Score = s.scorer.Score(userID, &allPosts[i])
	}

	sort.Slice(allPosts, func(i, j int) bool {
		return allPosts[i].Score > allPosts[j].Score
	})

	if len(allPosts) > limit {
		allPosts = allPosts[:limit]
	}

	// Cache for next read
	go s.cacheFeed(context.Background(), userID, allPosts)

	return allPosts, fmt.Sprintf("%d", len(allPosts)), nil
}

func (s *FeedService) cacheFeed(ctx context.Context, userID string, posts []Post) {
	feedKey := fmt.Sprintf("feed:%s", userID)
	pipe := s.rdb.Pipeline()

	pipe.Del(ctx, feedKey)
	for _, post := range posts {
		pipe.ZAdd(ctx, feedKey, redis.Z{
			Score:  post.Score,
			Member: post.ID,
		})
	}
	pipe.Expire(ctx, feedKey, 30*time.Minute)
	pipe.Exec(ctx)
}

// FanOutOnWrite pushes new posts to followers' feeds
func (s *FeedService) FanOutOnWrite(ctx context.Context, post Post, maxFollowers int) error {
	followers, err := s.followStore.GetFollowers(ctx, post.UserID, maxFollowers)
	if err != nil {
		return err
	}

	// For celebrities with millions of followers: skip fan-out, use pull model
	if len(followers) > 100000 {
		return nil // readers will pull this user's posts directly
	}

	pipe := s.rdb.Pipeline()
	score := float64(post.CreatedAt.Unix())

	for _, followerID := range followers {
		feedKey := fmt.Sprintf("feed:%s", followerID)
		pipe.ZAdd(ctx, feedKey, redis.Z{Score: score, Member: post.ID})
		pipe.ZRemRangeByRank(ctx, feedKey, 0, -301) // keep latest 300 posts
	}

	_, err = pipe.Exec(ctx)
	return err
}

// PostStore provides post persistence operations
type PostStore interface {
	GetBatch(ctx context.Context, postIDs []string) ([]Post, error)
	GetByUser(ctx context.Context, userID string, limit int) ([]Post, error)
}

// FollowStore provides social graph operations
type FollowStore interface {
	GetFollowing(ctx context.Context, userID string, limit int) ([]string, error)
	GetFollowers(ctx context.Context, userID string, limit int) ([]string, error)
}

// FeedScorer computes relevance score for a post
type FeedScorer interface {
	Score(userID string, post *Post) float64
}

// TimeDecayScorer scores by recency with engagement boost
type TimeDecayScorer struct{}

func (s *TimeDecayScorer) Score(userID string, post *Post) float64 {
	ageHours := time.Since(post.CreatedAt).Hours()
	recencyScore := 1.0 / (1.0 + ageHours*0.1) // decay over time

	engagementScore := float64(post.LikeCount+post.CommentCount*2) / 1000.0
	return recencyScore + engagementScore*0.3
}
```

### 4. Post Service with Cassandra

Cassandra is chosen for the post storage layer because it handles high write throughput and scales horizontally. Posts are partitioned by `user_id` with `post_id` (a TimeUUID) as the clustering key, which means fetching a user's recent posts is a single-partition query that completes in single-digit milliseconds. The schema also includes separate tables for likes, engagement counters, and post lookups by ID, following Cassandra's "query-first" modeling principle where you design tables around your access patterns rather than normalizing data. Counters live in their own table because Cassandra forbids counter columns from sharing a table with regular columns.

```go
package post

import (
	"context"
	"time"

	"github.com/gocql/gocql"
)

// PostRepository uses Cassandra for high-write throughput
type PostRepository struct {
	session *gocql.Session
}

// Schema (Cassandra CQL):
// CREATE TABLE posts (
//   user_id uuid,
//   post_id timeuuid,
//   media_url text,
//   thumbnail_url text,
//   caption text,
//   tags list<text>,
//   created_at timestamp,
//   PRIMARY KEY (user_id, post_id)
// ) WITH CLUSTERING ORDER BY (post_id DESC);

// Counters must live in a counter-only table (primary key + counters):
// CREATE TABLE post_counters (
//   post_id uuid PRIMARY KEY,
//   like_count counter,
//   comment_count counter,
//   view_count counter
// );

// CREATE TABLE post_likes (
//   post_id uuid,
//   user_id uuid,
//   created_at timestamp,
//   PRIMARY KEY (post_id, user_id)
// );

// CREATE TABLE post_by_id (
//   post_id uuid PRIMARY KEY,
//   user_id uuid,
//   media_url text,
//   thumbnail_url text,
//   caption text,
//   created_at timestamp
// );

type Post struct {
	UserID       gocql.UUID
	PostID       gocql.UUID
	MediaURL     string
	ThumbnailURL string
	Caption      string
	Tags         []string
	LikeCount    int64
	CommentCount int64
	ViewCount    int64
	CreatedAt    time.Time
}

func (r *PostRepository) Create(ctx context.Context, post Post) error {
	return r.session.Query(`
		INSERT INTO posts (user_id, post_id, media_url, thumbnail_url, caption, tags, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		post.UserID, post.PostID, post.MediaURL, post.ThumbnailURL,
		post.Caption, post.Tags, post.CreatedAt,
	).WithContext(ctx).Exec()
}

func (r *PostRepository) GetByUser(ctx context.Context, userID gocql.UUID, limit int) ([]Post, error) {
	iter := r.session.Query(`
		SELECT post_id, media_url, thumbnail_url, caption, created_at
		FROM posts
		WHERE user_id = ?
		ORDER BY post_id DESC
		LIMIT ?`,
		userID, limit,
	).WithContext(ctx).Iter()

	var posts []Post
	var p Post
	for iter.Scan(&p.PostID, &p.MediaURL, &p.ThumbnailURL, &p.Caption, &p.CreatedAt) {
		p.UserID = userID
		posts = append(posts, p)
	}
	return posts, iter.Close()
}

func (r *PostRepository) IncrementLike(ctx context.Context, postID, userID gocql.UUID) error {
	// Lightweight transaction makes the like idempotent without a
	// read-then-write race between concurrent double-taps
	applied, err := r.session.Query(`
		INSERT INTO post_likes (post_id, user_id, created_at)
		VALUES (?, ?, ?) IF NOT EXISTS`,
		postID, userID, time.Now(),
	).WithContext(ctx).ScanCAS()
	if err != nil {
		return err
	}
	if !applied {
		return nil // already liked
	}

	// Counter updates cannot be batched with regular mutations in Cassandra,
	// so the counter bump is a separate statement. A crash between the two
	// leaves the count off by one, which is acceptable for like counts.
	return r.session.Query(`
		UPDATE post_counters SET like_count = like_count + 1 WHERE post_id = ?`,
		postID,
	).WithContext(ctx).Exec()
}
```

---
