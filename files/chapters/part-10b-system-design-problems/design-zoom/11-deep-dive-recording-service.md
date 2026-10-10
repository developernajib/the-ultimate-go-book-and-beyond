## Deep Dive: Recording Service

Recording a video conference is more complex than simply saving a file. The system must capture every participant's audio and video stream in real time, store the raw streams temporarily, and then mix them into a single MP4 file after the meeting ends. The mixing step is computationally expensive because it involves compositing multiple video feeds into a chosen layout (speaker view or gallery view) and merging all audio tracks. This is why recording uses a two-phase approach: capture raw streams during the meeting, then process them asynchronously afterward.

```go
package recording

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type RecordingService struct {
	db    *pgxpool.Pool
	s3    S3Client
	mixer AudioVideoMixer
	// capture attaches a recording client to the live meeting as an extra
	// subscriber and writes each participant's raw track to object storage
	// until the context is cancelled.
	capture StreamCapturer
}

// StreamCapturer is the phase-one half of recording: it subscribes to the
// meeting and persists raw tracks. Phase two (Mix) runs later, offline.
type StreamCapturer interface {
	Capture(ctx context.Context, meetingID, rawPrefix string) error
}

// AudioVideoMixer composites the stored raw tracks into one MP4 and
// reports the output size and duration.
type AudioVideoMixer interface {
	Mix(ctx context.Context, rawPrefix, outputKey string) (sizeBytes int64, durationSec int, err error)
}

type S3Client interface {
	Delete(ctx context.Context, prefix string) error
}

type Recording struct {
	ID, MeetingID, HostID, Status, S3Key, Layout string
	DurationSec                                  int
	SizeBytes                                    int64
	CreatedAt                                    time.Time
}

func (s *RecordingService) StartRecording(ctx context.Context, meetingID, hostID, layout string) (*Recording, error) {
	rec := &Recording{
		// A random ID, not fmt.Sprintf("rec_%d", time.Now().UnixNano()).
		// This ID appears in the download URL, and a timestamp-derived ID
		// is guessable by anyone who knows roughly when a meeting ran.
		ID:        uuid.NewString(),
		MeetingID: meetingID,
		HostID:    hostID,
		Status:    "recording",
		Layout:    layout,
		CreatedAt: time.Now(),
	}

	_, err := s.db.Exec(ctx, `
		INSERT INTO recordings (id, meeting_id, host_id, status, layout, created_at)
		VALUES ($1, $2, $3, $4, $5, NOW())`,
		rec.ID, meetingID, hostID, rec.Status, layout)
	if err != nil {
		return nil, err
	}

	// Capture must outlive this request. Handing the goroutine the
	// request's ctx would cancel the capture the instant StartRecording
	// returns to the caller, and the recording would end up empty with
	// every status column still saying "recording". Derive a context that
	// keeps the request's values (trace IDs, tenant) but not its deadline,
	// and give it a bound of its own.
	captureCtx, cancel := context.WithTimeout(
		context.WithoutCancel(ctx), maxRecordingDuration)

	go func() {
		defer cancel()
		rawPrefix := fmt.Sprintf("recordings/raw/%s/", rec.ID)
		if err := s.capture.Capture(captureCtx, meetingID, rawPrefix); err != nil {
			s.markFailed(captureCtx, rec.ID)
		}
	}()

	return rec, nil
}

// maxRecordingDuration is a backstop. If the meeting-ended signal is lost,
// capture stops here rather than writing to S3 forever.
const maxRecordingDuration = 24 * time.Hour

func (s *RecordingService) ProcessRecording(ctx context.Context, recID string) error {
	if _, err := s.db.Exec(ctx,
		"UPDATE recordings SET status='processing' WHERE id=$1", recID); err != nil {
		return err
	}

	rawPrefix := fmt.Sprintf("recordings/raw/%s/", recID)
	outputKey := fmt.Sprintf("recordings/final/%s.mp4", recID)

	size, dur, err := s.mixer.Mix(ctx, rawPrefix, outputKey)
	if err != nil {
		s.markFailed(ctx, recID)
		return fmt.Errorf("mix recording %s: %w", recID, err)
	}

	if _, err := s.db.Exec(ctx, `
		UPDATE recordings SET status='ready', s3_key=$1, size_bytes=$2, duration_sec=$3
		WHERE id=$4`, outputKey, size, dur, recID); err != nil {
		return err
	}

	// Only now are the raw tracks redundant. Deleting them before the row
	// says "ready" would leave a failed retry with nothing to mix from.
	return s.s3.Delete(ctx, rawPrefix)
}

func (s *RecordingService) markFailed(ctx context.Context, recID string) {
	// Deliberately ignores its own error: this is already the error path,
	// and the sweeper that looks for rows stuck in a non-terminal status
	// is the real backstop.
	s.db.Exec(ctx, "UPDATE recordings SET status='failed' WHERE id=$1", recID)
}
```

`StartRecording` returns as soon as the row is written, so the API responds in milliseconds while capture runs for the length of the meeting. That split is the whole design, and it is also where the two easiest bugs live. The first is the context: a goroutine that outlives its request must not hold the request's context, or it dies at the handler's return. The second is that capture is an interface here rather than an empty method body. A `captureStreams` stub that does nothing compiles, returns `nil`, marks the row `recording`, and produces a silent, permanent absence of data that no test catches and no alert fires on.

---
