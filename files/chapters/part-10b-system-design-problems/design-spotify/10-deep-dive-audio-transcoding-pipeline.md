## Deep Dive: Audio Transcoding Pipeline

When an artist or label uploads a new track, the raw audio has to be converted into every format and bitrate the fleet of clients might ask for. The pipeline takes the original lossless master and produces Ogg Vorbis at 96, 160, and 320 kbps plus a FLAC rung at up to 24-bit/44.1 kHz, each cut into 10-second segments, and an unsegmented copy of the 320 kbps stream for offline download. Segmenting is what makes mid-stream quality switching possible: the client finishes the segment it has and requests the next one from a different bitrate ladder rung.

The FLAC rung is the one that breaks the pattern, and it is worth seeing why before reading the ladder. Every other rung is a target the encoder is told to hit, so its bitrate is an input. FLAC is lossless, so its bitrate is whatever the material happens to compress to and the encoder has no bitrate knob to turn at all. That single difference is why `Bitrate` is zero for that rung, why the codec and extension change together, and why the capacity model downstream has to plan against a derived average instead of a number anyone promised.

The critical detail is that the transcoder and the streaming service must agree on where the bytes land. The output key here is built from the same `(trackID, quality, segment)` shape that `s3Key` in the Audio Delivery Service reads. Let those two drift and the pipeline reports success while every stream 404s, which is the kind of bug that only shows up in production because the transcoder's own tests never read the files back.

```go
package transcoding

import (
	"context"
	"fmt"
	"time"
)

type S3Client interface {
}

type JobQueue interface {
	Enqueue(ctx context.Context, job TranscodeJob) error
}

type WorkerPool interface {
	Execute(ctx context.Context, cmd FFmpegCommand) error
}

type TranscodingPipeline struct {
	s3       S3Client
	queue    JobQueue
	ffmpeg   WorkerPool
	analyzer AudioAnalyzer // owns the DSP/model that derives track features
}

type TranscodeJob struct {
	TrackID, SourceKey string
	Format             OutputFormat
	Status             string
	CreatedAt          time.Time
}

// OutputFormat names one rung of the bitrate ladder. Quality is the label the
// streaming service uses in its keys ("low"/"normal"/"high"/"lossless"), and
// it must match AudioQuality.String() on the reader side. Ext must match
// AudioQuality.Ext(). Bitrate is what ffmpeg is told to encode at, or 0 for a
// lossless codec that has nothing to be told. All of it lives here so that one
// rung is one row and the fields cannot drift apart from each other.
type OutputFormat struct {
	Quality   string
	Codec     string
	Ext       string
	Bitrate   int
	Segmented bool
}

var ladder = []OutputFormat{
	{Quality: "low", Codec: "libvorbis", Ext: "ogg", Bitrate: 96, Segmented: true},
	{Quality: "normal", Codec: "libvorbis", Ext: "ogg", Bitrate: 160, Segmented: true},
	{Quality: "high", Codec: "libvorbis", Ext: "ogg", Bitrate: 320, Segmented: true},
	// FLAC is lossless, so Bitrate is an output of the encode rather than an
	// input to it. Bitrate: 0 means "do not pass -b:a", and passing one here
	// would be a instruction ffmpeg ignores for FLAC, leaving a number in the
	// config that looks authoritative and controls nothing.
	{Quality: "lossless", Codec: "flac", Ext: "flac", Bitrate: 0, Segmented: true},
	{Quality: "high", Codec: "libvorbis", Ext: "ogg", Bitrate: 320, Segmented: false},  // offline copy
	{Quality: "lossless", Codec: "flac", Ext: "flac", Bitrate: 0, Segmented: false},     // offline copy
}

// ProcessUpload fans one upload out into one job per ladder rung.
func (p *TranscodingPipeline) ProcessUpload(ctx context.Context, trackID, sourceKey string) error {
	for _, f := range ladder {
		job := TranscodeJob{
			TrackID:   trackID,
			SourceKey: sourceKey,
			Format:    f,
			Status:    "pending",
			CreatedAt: time.Now(),
		}
		// Enqueue can fail, and a dropped error here means the track is live in
		// the catalog with no audio behind it. Fail the upload instead: the
		// already-enqueued rungs are idempotent and safe to redo on retry.
		if err := p.queue.Enqueue(ctx, job); err != nil {
			return fmt.Errorf("enqueue %s %s: %w", trackID, f.Quality, err)
		}
	}
	return nil
}

func (p *TranscodingPipeline) TranscodeWorker(ctx context.Context, job TranscodeJob) error {
	f := job.Format
	var cmd FFmpegCommand
	if f.Segmented {
		// Vorbis: ffmpeg -i src -c:a libvorbis -b:a 160k -f segment -segment_time 10
		// FLAC:   ffmpeg -i src -c:a flac -f segment -segment_time 10
		// The FLAC form has no -b:a at all, which is what Bitrate: 0 encodes.
		cmd = FFmpegCommand{
			Input:       job.SourceKey,
			OutputDir:   fmt.Sprintf("audio/%s/%s/", job.TrackID, f.Quality),
			Pattern:     fmt.Sprintf("seg_%%04d.%s", f.Ext),
			Codec:       f.Codec,
			Bitrate:     f.Bitrate,
			SegmentTime: 10,
		}
	} else {
		cmd = FFmpegCommand{
			Input:   job.SourceKey,
			Output:  fmt.Sprintf("audio/%s/%s/%s.%s", job.TrackID, f.Quality, job.TrackID, f.Ext),
			Codec:   f.Codec,
			Bitrate: f.Bitrate,
		}
	}

	if err := p.ffmpeg.Execute(ctx, cmd); err != nil {
		// Let it surface so the queue retries. Swallowing this is how you end
		// up with a "completed" job and a silently missing rung.
		return fmt.Errorf("transcode %s %s: %w", job.TrackID, f.Quality, err)
	}
	return nil
}

// ExtractAudioFeatures derives the content features used for cold-start
// recommendation, when a track has too few plays for collaborative filtering
// to place it. These come from analyzing the decoded waveform, so this is a
// real call into the analyzer rather than something the pipeline can guess.
func (p *TranscodingPipeline) ExtractAudioFeatures(ctx context.Context, trackID, sourceKey string) (*AudioFeatures, error) {
	feat, err := p.analyzer.Analyze(ctx, sourceKey)
	if err != nil {
		return nil, fmt.Errorf("analyze %s: %w", trackID, err)
	}
	feat.TrackID = trackID
	return feat, nil
}

type AudioFeatures struct {
	TrackID                       string
	Tempo                         float64 // BPM
	Danceability, Energy, Valence float64 // 0-1
}

type FFmpegCommand struct {
	Input, Output, OutputDir string
	Pattern                  string // segment filename template
	Codec                    string
	Bitrate                  int // kbps, 0 omits -b:a entirely (lossless codecs)
	SegmentTime              int
}

type AudioAnalyzer interface {
	Analyze(ctx context.Context, sourceKey string) (*AudioFeatures, error)
}
```

---
