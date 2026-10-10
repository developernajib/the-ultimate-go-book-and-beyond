## Video Upload and Processing Pipeline

### The Object Key Layout Is the Contract

Before any code, pin down the S3 key layout, because it is the one interface the writer and the reader of this pipeline share and neither one can see the other. The transcoder writes keys. The player reads URLs. Nothing type-checks across that boundary, nothing fails at build time, and a mismatch does not surface until a real viewer hits play and gets a 404 from a pipeline whose every job is marked succeeded. This is the single most common way a video pipeline is broken in production while every dashboard is green.

```
raw/{video_id}/original                       source master, written by the client
videos/{video_id}/master.m3u8                 multivariant playlist, written by the worker
videos/{video_id}/{quality}/index.m3u8        media playlist per rung
videos/{video_id}/{quality}/init.mp4          CMAF init segment (fMP4 header)
videos/{video_id}/{quality}/seg_00001.m4s     media segments, ~6s each
videos/{video_id}/thumb_{n}.jpg               thumbnails
```

The segments are CMAF fragmented MP4 rather than MPEG-TS, for two reasons. Apple's HLS spec only permits HEVC in fMP4, so a ladder with an HEVC 4K rung cannot use TS for that rung at all. And a single set of CMAF segments can be addressed by both an HLS playlist and a DASH manifest, so you store the bytes once and serve both ecosystems from the same CDN cache entries instead of doubling your storage and halving your hit rate.

Every key in this chapter comes from the four helpers below, which live in a small shared package that the upload, transcoding, and streaming services all depend on. Derive keys in one place, call the same helper from both sides, and never hand-format a key at a call site. Notice that the CDN base URL maps onto the bucket root, so the player URL for the multivariant playlist is `{cdn_base}/videos/{video_id}/master.m3u8`. Dropping the `videos/` prefix on the read side is exactly the bug this layout exists to prevent.

```go
// RawKey locates the source master the client uploaded.
func RawKey(videoID string) string { return fmt.Sprintf("raw/%s/original", videoID) }

// VideoDir is the prefix holding everything playable for a video. CDN
// authorization is scoped to this prefix.
func VideoDir(videoID string) string { return fmt.Sprintf("videos/%s", videoID) }

// MasterKey locates the multivariant playlist the player fetches first.
func MasterKey(videoID string) string { return VideoDir(videoID) + "/master.m3u8" }

// VariantDir is the prefix every segment for a rung lives under. Lifecycle
// rules and cache invalidation both operate on this prefix.
func VariantDir(videoID, quality string) string {
	return VideoDir(videoID) + "/" + quality
}

// VariantPlaylistKey locates one rung's media playlist.
func VariantPlaylistKey(videoID, quality string) string {
	return VariantDir(videoID, quality) + "/index.m3u8"
}
```

### Upload Flow

The upload flow uses presigned S3 URLs so that video files go directly from the client to object storage, bypassing your API servers entirely. This is essential at YouTube scale because routing hundreds of gigabytes per second through your own servers would require enormous bandwidth and add unnecessary latency. After the client completes the upload, it notifies the API, which then enqueues a transcoding job for asynchronous processing.

One constraint drives the shape of this code: a single S3 `PutObject` is capped at 5GB, and it is not resumable. A dropped connection at 90% means starting over. Source masters routinely exceed 5GB, so anything above a few hundred megabytes goes through multipart upload instead, where the client gets one presigned URL per part and can retry individual parts. The threshold below is set at 100MB, well under the hard limit, because resumability matters long before the limit does.

```go
package upload

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// UploadService handles video upload initiation and completion
type UploadService struct {
	s3Client  *s3.Client
	sqsClient *sqs.Client
	videoDB   VideoStore
	queueURL  string
}

// UploadRequest starts a resumable upload session
type UploadRequest struct {
	UploaderID    string `json:"uploader_id"`
	Title         string `json:"title"`
	Description   string `json:"description"`
	FileSizeBytes int64  `json:"file_size"`
	ContentType   string `json:"content_type"` // "video/mp4", "video/webm"
}

// UploadSession is returned to the client. Small files get a single PUT URL.
// Anything larger gets a multipart upload ID plus one presigned URL per part,
// so a failed part is retried on its own instead of restarting the whole file.
type UploadSession struct {
	VideoID      string    `json:"video_id"`
	UploadID     string    `json:"upload_id,omitempty"`     // S3 multipart upload ID
	PresignedURL string    `json:"presigned_url,omitempty"` // single-PUT path only
	PartURLs     []string  `json:"part_urls,omitempty"`     // multipart path, index 0 = part 1
	PartSize     int64     `json:"part_size,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
}

const (
	uploadsBucket    = "uploads-bucket"
	multipartMinSize = 100 << 20 // 100MB: above this, use resumable multipart
	partSize         = 64 << 20  // 64MB parts (S3 minimum is 5MB except for the last part)
	uploadTTL        = 4 * time.Hour
)

// InitiateUpload creates the video record and the presigned URLs the client
// uploads to directly. Our servers never touch the video bytes.
func (s *UploadService) InitiateUpload(ctx context.Context, req UploadRequest) (*UploadSession, error) {
	if req.FileSizeBytes <= 0 {
		return nil, fmt.Errorf("file_size must be positive")
	}
	videoID := generateVideoID()
	rawKey := RawKey(videoID)

	// Create the video record first. If the client abandons the upload, a
	// lifecycle rule reaps the S3 parts and a sweeper marks the row abandoned.
	video := Video{
		ID:          videoID,
		UploaderID:  req.UploaderID,
		Title:       req.Title,
		Description: req.Description,
		RawKey:      rawKey,
		Status:      VideoStatusUploading,
		CreatedAt:   time.Now(),
	}
	if err := s.videoDB.Create(ctx, video); err != nil {
		return nil, fmt.Errorf("create video: %w", err)
	}

	presignClient := s3.NewPresignClient(s.s3Client)
	session := &UploadSession{VideoID: videoID, ExpiresAt: time.Now().Add(uploadTTL)}

	if req.FileSizeBytes < multipartMinSize {
		presigned, err := presignClient.PresignPutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(uploadsBucket),
			Key:         aws.String(rawKey),
			ContentType: aws.String(req.ContentType),
		}, s3.WithPresignExpires(uploadTTL))
		if err != nil {
			return nil, fmt.Errorf("presign put: %w", err)
		}
		session.PresignedURL = presigned.URL
		return session, nil
	}

	created, err := s.s3Client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket:      aws.String(uploadsBucket),
		Key:         aws.String(rawKey),
		ContentType: aws.String(req.ContentType),
	})
	if err != nil {
		return nil, fmt.Errorf("create multipart: %w", err)
	}

	parts := int((req.FileSizeBytes + partSize - 1) / partSize)
	session.UploadID = *created.UploadId
	session.PartSize = partSize
	session.PartURLs = make([]string, 0, parts)
	for i := 1; i <= parts; i++ {
		p, err := presignClient.PresignUploadPart(ctx, &s3.UploadPartInput{
			Bucket:     aws.String(uploadsBucket),
			Key:        aws.String(rawKey),
			UploadId:   created.UploadId,
			PartNumber: aws.Int32(int32(i)),
		}, s3.WithPresignExpires(uploadTTL))
		if err != nil {
			return nil, fmt.Errorf("presign part %d: %w", i, err)
		}
		session.PartURLs = append(session.PartURLs, p.URL)
	}
	return session, nil
}

// CompletedPart is the ETag the client got back from each part upload.
type CompletedPart struct {
	PartNumber int32  `json:"part_number"`
	ETag       string `json:"etag"`
}

// CompleteUpload is called after the client finishes uploading to S3. For the
// multipart path it must assemble the object before anything can read it: until
// CompleteMultipartUpload returns, the key does not exist and the transcoder
// would download nothing.
func (s *UploadService) CompleteUpload(ctx context.Context, videoID, uploadID string, parts []CompletedPart) error {
	video, err := s.videoDB.Get(ctx, videoID)
	if err != nil {
		return fmt.Errorf("get video: %w", err)
	}

	if uploadID != "" {
		completed := make([]types.CompletedPart, 0, len(parts))
		for _, p := range parts {
			completed = append(completed, types.CompletedPart{
				PartNumber: aws.Int32(p.PartNumber),
				ETag:       aws.String(p.ETag),
			})
		}
		sort.Slice(completed, func(i, j int) bool {
			return *completed[i].PartNumber < *completed[j].PartNumber
		})
		if _, err := s.s3Client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
			Bucket:          aws.String(uploadsBucket),
			Key:             aws.String(video.RawKey),
			UploadId:        aws.String(uploadID),
			MultipartUpload: &types.CompletedMultipartUpload{Parts: completed},
		}); err != nil {
			return fmt.Errorf("complete multipart: %w", err)
		}
	}

	if err := s.videoDB.UpdateStatus(ctx, videoID, VideoStatusProcessing); err != nil {
		return err
	}

	// The job carries RawKey explicitly. The worker must not have to re-derive
	// it, and must not have to read the DB before it can start downloading.
	return s.enqueueTranscodeJob(ctx, TranscodeJob{
		VideoID:  videoID,
		RawKey:   video.RawKey,
		Priority: JobPriorityNormal,
		QueuedAt: time.Now(),
	})
}

func (s *UploadService) enqueueTranscodeJob(ctx context.Context, job TranscodeJob) error {
	body, _ := json.Marshal(job)
	_, err := s.sqsClient.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    &s.queueURL,
		MessageBody: aws.String(string(body)),
	})
	return err
}
```

### Transcoding Worker

The transcoding worker is the backbone of the video processing pipeline. It polls an SQS queue for jobs, downloads the raw video from S3, and uses FFmpeg to encode the video into multiple quality levels (from 240p to 4K). Each quality level is split into 6-second HLS segments so players can switch quality adaptively. Six seconds is what Apple's HLS Authoring Specification recommends as the target segment duration, and it is a genuine trade-off: shorter segments cut startup latency and let ABR react faster, longer segments compress better and cut request overhead at the edge.

Two details in this code carry more weight than they look. First, every rung is encoded with forced keyframes on the same six-second grid. Without that, segment boundaries land on different frames per rung, and a player switching quality mid-stream either stalls or shows a visual glitch, because the segments do not line up. ABR is only seamless if the ladder is keyframe-aligned. Second, the worker uploads the segments and the media playlists, not just the master. A worker that writes files to local disk, uploads a manifest pointing at the CDN, and reports success has produced a video where every segment request 404s, and nothing in the pipeline notices, because from SQS's point of view the job completed.

The worker is stateless. If it crashes mid-job, the SQS message becomes visible again and another worker retries. Encoding is idempotent on the key layout, so a retry simply overwrites the same keys. One operational catch: a full ladder for a long video runs for many minutes, far past SQS's 30-second default visibility timeout, so a second worker would pick up a job that is still being processed and you would pay twice to encode it. Either set the queue's visibility timeout above your worst-case job duration, or have the worker call `ChangeMessageVisibility` on a heartbeat while FFmpeg runs. The heartbeat is better, because it also releases the job quickly when a worker dies rather than after a long fixed timeout.

```go
package transcoding

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// SegmentSeconds is the target segment duration. Apple's HLS Authoring
// Specification recommends 6 seconds. Every rung is keyframe-aligned to this
// grid so the player can switch rungs at any segment boundary.
const SegmentSeconds = 6

// Quality is one rung of the encoding ladder.
type Quality struct {
	Name     string
	Width    int
	Height   int
	VideoBPS string
	AudioBPS string
	Encoder  string // FFmpeg encoder
	RFC6381  string // codec string advertised in the playlist, must match Encoder
}

// Qualities is the fixed ladder. Two rules govern this table and both have bitten
// real pipelines: every rung the player can select must actually be produced here
// (a rung in the playlist that the transcoder never wrote is a guaranteed 404),
// and the RFC 6381 codec string must describe the encoder that produced the rung
// (advertise H.264 for an HEVC rung and compliant players reject the variant).
//
// The bitrates are delivery bitrates, not upload bitrates. They sum to ~26Mbps,
// which is where the ~12GB per source hour in the capacity estimate comes from.
var Qualities = []Quality{
	{Name: "4k", Width: 3840, Height: 2160, VideoBPS: "16M", AudioBPS: "256k", Encoder: "libx265", RFC6381: "hvc1.1.6.L153.B0"},
	{Name: "1080p", Width: 1920, Height: 1080, VideoBPS: "5M", AudioBPS: "192k", Encoder: "libx264", RFC6381: "avc1.640028"},
	{Name: "720p", Width: 1280, Height: 720, VideoBPS: "2500k", AudioBPS: "192k", Encoder: "libx264", RFC6381: "avc1.64001f"},
	{Name: "480p", Width: 854, Height: 480, VideoBPS: "1200k", AudioBPS: "128k", Encoder: "libx264", RFC6381: "avc1.64001e"},
	{Name: "360p", Width: 640, Height: 360, VideoBPS: "700k", AudioBPS: "128k", Encoder: "libx264", RFC6381: "avc1.64001e"},
	{Name: "240p", Width: 426, Height: 240, VideoBPS: "500k", AudioBPS: "64k", Encoder: "libx264", RFC6381: "avc1.640015"},
}

// This is a fixed ladder, which is the right starting point and the wrong place
// to stop. Netflix has published its per-title encoding work: rather than
// applying one ladder to everything, it runs a large number of test encodes per
// title, scores them with VMAF, and derives a ladder fitted to that title's
// complexity. A talking-head interview and an action sequence do not deserve the
// same bitrate at 1080p. Netflix's later dynamic optimizer work pushes the same
// idea down to the shot level. The payoff is real bandwidth savings at equal
// measured quality, and the cost is compute plus a variable ladder your player
// and your manifest generator must not assume anything about.

// Worker processes transcoding jobs from SQS
type Worker struct {
	s3Client  S3Client
	sqsClient SQSClient
	videoDB   VideoStore
	queueURL  string
	workDir   string
}

// Process polls SQS and transcodes videos until the context is cancelled.
func (w *Worker) Process(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		msgs, err := w.sqsClient.ReceiveMessages(ctx, w.queueURL, 1)
		if err != nil || len(msgs) == 0 {
			// Sleep on the context, not on time.Sleep: a plain sleep keeps the
			// worker alive for up to 2 more seconds after a shutdown signal,
			// which multiplied across 15,000 workers is a slow, ugly rollout.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
			continue
		}

		for _, msg := range msgs {
			if err := w.handleJob(ctx, msg); err != nil {
				// Leave the message in the queue. The visibility timeout expires
				// and another worker retries. After maxReceiveCount attempts the
				// redrive policy moves it to the DLQ.
				continue
			}
			w.sqsClient.DeleteMessage(ctx, w.queueURL, msg.ReceiptHandle)
		}
	}
}

func (w *Worker) handleJob(ctx context.Context, msg SQSMessage) error {
	var job TranscodeJob
	if err := json.Unmarshal([]byte(msg.Body), &job); err != nil {
		// Malformed body will never parse. Retrying is pointless, so drop it to
		// the DLQ rather than looping until the redrive policy gives up.
		return fmt.Errorf("unmarshal job: %w", err)
	}
	if job.VideoID == "" || job.RawKey == "" {
		return fmt.Errorf("invalid job: video_id and raw_key are both required")
	}

	jobDir := filepath.Join(w.workDir, job.VideoID)
	defer os.RemoveAll(jobDir) // a worker handles thousands of jobs, do not leak disk

	inputPath := filepath.Join(jobDir, "original")
	if err := w.s3Client.Download(ctx, job.RawKey, inputPath); err != nil {
		return fmt.Errorf("download raw %q: %w", job.RawKey, err)
	}

	produced, err := TranscodeVideo(ctx, inputPath, jobDir)
	if err != nil {
		w.videoDB.UpdateStatus(ctx, job.VideoID, VideoStatusFailed)
		return err
	}

	// Publish the segments and media playlists BEFORE the master playlist. The
	// master is what the player resolves first, so it is the commit point: if we
	// crash halfway through, no master exists, the video stays in "processing",
	// and no viewer is ever handed a playlist pointing at objects that are not
	// there yet. Publishing the master first would expose a window where every
	// segment request 404s.
	for _, q := range produced {
		if err := w.uploadVariant(ctx, job.VideoID, q, jobDir); err != nil {
			w.videoDB.UpdateStatus(ctx, job.VideoID, VideoStatusFailed)
			return fmt.Errorf("upload variant %s: %w", q.Name, err)
		}
	}

	master := GenerateMasterPlaylist(produced)
	masterKey := MasterKey(job.VideoID)
	if err := w.s3Client.UploadString(ctx, masterKey, master, "application/vnd.apple.mpegurl"); err != nil {
		return fmt.Errorf("upload master playlist: %w", err)
	}

	return w.videoDB.UpdateReady(ctx, job.VideoID, masterKey, produced)
}

// uploadVariant copies one rung's playlist, init segment, and media segments to
// the exact keys the master playlist will point at. Both sides derive the key
// from the same helper, which is the only thing keeping them in agreement.
func (w *Worker) uploadVariant(ctx context.Context, videoID string, q Quality, jobDir string) error {
	localDir := filepath.Join(jobDir, q.Name)
	entries, err := os.ReadDir(localDir)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return fmt.Errorf("ffmpeg produced no output for rung %s", q.Name)
	}

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		key := path.Join(VariantDir(videoID, q.Name), e.Name())
		if err := w.s3Client.UploadFile(ctx, key, filepath.Join(localDir, e.Name()), contentTypeFor(e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func contentTypeFor(name string) string {
	switch path.Ext(name) {
	case ".m3u8":
		return "application/vnd.apple.mpegurl"
	case ".mp4", ".m4s":
		return "video/mp4"
	default:
		return "application/octet-stream"
	}
}

// TranscodeVideo encodes the source to every rung of the ladder as CMAF fMP4 and
// returns the rungs it actually produced. Only produced rungs may be advertised.
func TranscodeVideo(ctx context.Context, inputPath, jobDir string) ([]Quality, error) {
	produced := make([]Quality, 0, len(Qualities))

	for _, q := range Qualities {
		outDir := filepath.Join(jobDir, q.Name)
		if err := os.MkdirAll(outDir, 0o750); err != nil {
			return nil, err
		}

		args := []string{
			"-nostdin", "-y",
			"-i", inputPath,
			"-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:-1:-1", q.Width, q.Height, q.Width, q.Height),
			"-c:v", q.Encoder,
			// Capped VBR. -b:v alone lets quality swing wildly, and -crf alone
			// ignores the bitrate the playlist is about to advertise. The pair
			// gives CRF quality with a ceiling the ABR bandwidth math can trust.
			"-b:v", q.VideoBPS,
			"-maxrate", q.VideoBPS,
			"-bufsize", doubled(q.VideoBPS),
			// Force an IDR frame exactly on the segment grid. Without this the
			// rungs are not keyframe-aligned and switching rungs mid-playback
			// stalls or glitches, which defeats the entire point of the ladder.
			"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", SegmentSeconds),
			"-sc_threshold", "0", // no extra keyframes on scene cuts, they break the grid
			"-c:a", "aac",
			"-b:a", q.AudioBPS,
		}

		if q.Encoder == "libx265" {
			// hvc1 tagging, not hev1: Apple devices require it.
			args = append(args, "-preset", "slow", "-tag:v", "hvc1")
		} else {
			args = append(args, "-preset", "fast", "-profile:v", "high")
		}

		args = append(args,
			"-f", "hls",
			"-hls_time", strconv.Itoa(SegmentSeconds),
			"-hls_playlist_type", "vod",
			"-hls_list_size", "0", // VOD playlist keeps every segment
			"-hls_segment_type", "fmp4",
			"-hls_fmp4_init_filename", "init.mp4",
			"-hls_segment_filename", filepath.Join(outDir, "seg_%05d.m4s"),
			filepath.Join(outDir, "index.m3u8"),
		)

		cmd := exec.CommandContext(ctx, "ffmpeg", args...)
		if output, err := cmd.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("transcode %s: %w\nffmpeg: %s", q.Name, err, output)
		}
		produced = append(produced, q)
	}

	return produced, nil
}

// GenerateMasterPlaylist writes the multivariant playlist. The URIs are relative
// to the playlist itself, so the same objects serve correctly from any CDN
// hostname and nothing here has to know the CDN base URL.
func GenerateMasterPlaylist(produced []Quality) string {
	// Version 7 is the floor for fMP4 segments (EXT-X-MAP).
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:7\n\n")

	for _, q := range produced {
		bandwidth := parseBandwidth(q.VideoBPS) + parseBandwidth(q.AudioBPS)
		fmt.Fprintf(&b,
			"#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s,mp4a.40.2\"\n%s/index.m3u8\n\n",
			bandwidth, q.Width, q.Height, q.RFC6381, q.Name,
		)
	}

	return b.String()
}

// doubled returns twice the given FFmpeg bitrate string, for -bufsize.
func doubled(bps string) string {
	return strconv.Itoa(parseBandwidth(bps)*2/1000) + "k"
}

func parseBandwidth(bps string) int {
	if len(bps) == 0 {
		return 0
	}
	n := 0
	mult := 1
	unit := bps[len(bps)-1]
	switch unit {
	case 'M', 'm':
		mult = 1_000_000
		bps = bps[:len(bps)-1]
	case 'K', 'k':
		mult = 1_000
		bps = bps[:len(bps)-1]
	}
	fmt.Sscanf(bps, "%d", &n)
	return n * mult
}
```

### Streaming Service

The streaming service acts as the gateway between users and video content. When a user clicks play, this service verifies their access rights (subscription status, region restrictions), authorizes the viewer at the CDN, and returns a manifest URL that the player uses to fetch video segments. It also handles resume-from-last-position by looking up the user's watch history, so viewers continue where they left off without manual seeking.

The authorization mechanism deserves a hard look, because the obvious version is wrong. Signing only the master playlist URL with a `?token=` query parameter protects nothing: the master playlist's variant URIs are relative, relative URL resolution discards the query string, and so every media playlist and every segment is fetched with no token at all. You have signed the one file that contains no video. Signed cookies are the standard fix. The cookie is scoped to a path prefix (`/videos/{video_id}/`), the browser or player attaches it to every request under that prefix automatically, and the CDN validates it on the segments where it actually matters. CloudFront, Akamai, and Fastly all expose some form of this. The trade-off is that cookies do not travel across origins as freely as a signed URL, so native mobile players usually get short-lived signed URLs per media playlist instead.

```go
package streaming

import (
	"context"
	"fmt"
	"time"
)

// StreamingService serves video manifests and handles playback sessions
type StreamingService struct {
	videoDB   VideoStore
	tokenSvc  TokenService
	analytics AnalyticsService
	cdnBase   string
}

// StreamSession represents an active viewing session.
type StreamSession struct {
	SessionID   string `json:"session_id"`
	VideoID     string `json:"video_id"`
	UserID      string `json:"user_id"`
	ManifestURL string `json:"manifest_url"`
	// Cookies the client must present to the CDN. These, not the manifest URL,
	// are what actually authorize the segment requests.
	CDNCookies map[string]string `json:"cdn_cookies"`
	ResumeAt   float64           `json:"resume_at"` // seconds
	ExpiresAt  time.Time         `json:"expires_at"`
}

// InitiateStream authorizes a viewer and returns everything the player needs.
func (s *StreamingService) InitiateStream(ctx context.Context, videoID, userID string) (*StreamSession, error) {
	video, err := s.videoDB.Get(ctx, videoID)
	if err != nil {
		return nil, fmt.Errorf("get video: %w", err)
	}
	if video.Status != VideoStatusReady {
		return nil, fmt.Errorf("video not available for streaming: status=%s", video.Status)
	}

	// Check access control (subscription, region restrictions)
	if err := s.checkAccess(ctx, userID, video); err != nil {
		return nil, fmt.Errorf("access denied: %w", err)
	}

	// Authorize the whole key prefix, not one file. MasterKey is the same helper
	// the transcoding worker used to write the object, which is what guarantees
	// the URL we hand the player resolves to something that exists.
	cookies, expiry := s.tokenSvc.SignPrefix(videoID, userID, "/"+VideoDir(videoID)+"/*", 4*time.Hour)
	manifestURL := fmt.Sprintf("%s/%s", s.cdnBase, MasterKey(videoID))

	// Resume from last watched position. A failure here must not fail playback:
	// starting at 0 is a worse experience, not a broken one.
	resumeAt, err := s.analytics.GetWatchPosition(ctx, userID, videoID)
	if err != nil {
		resumeAt = 0
	}

	session := &StreamSession{
		SessionID:   generateSessionID(),
		VideoID:     videoID,
		UserID:      userID,
		ManifestURL: manifestURL,
		CDNCookies:  cookies,
		ResumeAt:    resumeAt,
		ExpiresAt:   expiry,
	}

	s.analytics.RecordStreamStart(ctx, session)
	return session, nil
}

// ReportProgress updates watch position (called every 30 seconds by client)
func (s *StreamingService) ReportProgress(ctx context.Context, userID, videoID string, positionSecs float64) error {
	return s.analytics.UpdateWatchPosition(ctx, userID, videoID, positionSecs)
}
```

---
