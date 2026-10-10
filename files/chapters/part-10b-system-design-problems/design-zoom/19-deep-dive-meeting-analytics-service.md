## Deep Dive: Meeting Analytics Service

Post-meeting analytics give enterprise customers the usage data they need for capacity planning, compliance, and measuring employee engagement. The `MeetingAnalyticsService` aggregates participant-level telemetry (join/leave times, audio quality MOS scores, whether video was enabled) into meeting-level summaries including peak concurrent participants, average connection quality, screen-share utilization percentage, and reconnect rate. These summaries are stored in PostgreSQL and exposed via a reporting API, while the raw per-participant records are retained for up to 90 days for detailed troubleshooting queries.

```go
package analytics

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MeetingAnalyticsService provides post-meeting insights
type MeetingAnalyticsService struct {
	db *pgxpool.Pool
}

type MeetingAnalytics struct {
	MeetingID          string                 `json:"meeting_id"`
	TotalDuration      time.Duration          `json:"total_duration"`
	UniqueParticipants int                    `json:"unique_participants"`
	PeakParticipants   int                    `json:"peak_participants"`
	AvgDuration        time.Duration          `json:"avg_participant_duration"`
	AudioOnlyPct       float64                `json:"audio_only_percent"`
	ScreenSharePct     float64                `json:"screen_share_percent"`
	AvgAudioQuality    float64                `json:"avg_audio_quality_mos"`
	AvgVideoQuality    float64                `json:"avg_video_quality_score"`
	ReconnectRate      float64                `json:"reconnect_rate"`
	RecordingSize      int64                  `json:"recording_size_bytes"`
	Participants       []ParticipantAnalytics `json:"participants"`
}

type ParticipantAnalytics struct {
	UserID      string    `json:"user_id"`
	DisplayName string    `json:"display_name"`
	JoinedAt    time.Time `json:"joined_at"`
	// LeftAt is nil while a participant is still connected. The column is
	// nullable, so the Go type must be too.
	LeftAt          *time.Time    `json:"left_at,omitempty"`
	Duration        time.Duration `json:"duration"`
	AudioOnTime     time.Duration `json:"audio_on_time"`
	VideoOnTime     time.Duration `json:"video_on_time"`
	ScreenShareTime time.Duration `json:"screen_share_time"`
	SpeakingTime    time.Duration `json:"speaking_time"`
	AvgAudioMOS     float64       `json:"avg_audio_mos"`
	ReconnectCount  int           `json:"reconnect_count"`
}

// GetMeetingAnalytics generates post-meeting analytics
func (s *MeetingAnalyticsService) GetMeetingAnalytics(ctx context.Context, meetingID string) (*MeetingAnalytics, error) {
	analytics := &MeetingAnalytics{MeetingID: meetingID}

	// started_at is NULL for a meeting that was scheduled but never
	// started, and ended_at is NULL for one still running. Both must be
	// scanned into pointers: a NULL into a plain time.Time is a scan
	// error, and that error is easy to swallow into a zero value.
	var startedAt, endedAt *time.Time
	err := s.db.QueryRow(ctx, `
		SELECT m.started_at, m.ended_at,
		       (SELECT COUNT(DISTINCT user_id)
		          FROM meeting_participants WHERE meeting_id = m.id)
		FROM meetings m WHERE m.id = $1`,
		meetingID).Scan(&startedAt, &endedAt, &analytics.UniqueParticipants)
	if err != nil {
		return nil, fmt.Errorf("load meeting %s: %w", meetingID, err)
	}

	// Each column lands in its own field. Passing &analytics.TotalDuration
	// twice, once for started_at and once for ended_at, compiles happily
	// and silently reports a zero-length meeting forever.
	if startedAt != nil {
		end := time.Now()
		if endedAt != nil {
			end = *endedAt
		}
		analytics.TotalDuration = end.Sub(*startedAt)
	}

	// Per-participant analytics. COALESCE the nullable analytics columns
	// so a participant who never reported quality does not fail the scan.
	rows, err := s.db.Query(ctx, `
		SELECT user_id,
		       COALESCE(display_name, ''),
		       joined_at,
		       left_at,
		       COALESCE(audio_on_seconds, 0),
		       COALESCE(video_on_seconds, 0),
		       COALESCE(screen_share_seconds, 0),
		       COALESCE(speaking_seconds, 0),
		       COALESCE(avg_audio_mos, 0),
		       COALESCE(reconnect_count, 0)
		FROM meeting_participants
		WHERE meeting_id = $1
		ORDER BY joined_at`,
		meetingID)
	if err != nil {
		return nil, fmt.Errorf("load participants for %s: %w", meetingID, err)
	}
	defer rows.Close()

	for rows.Next() {
		var pa ParticipantAnalytics
		var audioSec, videoSec, ssSec, speakSec int

		// Check the scan error. Ignoring it leaves a zero-valued struct in
		// the results that looks exactly like a real participant who sat
		// silent through the whole meeting.
		if err := rows.Scan(&pa.UserID, &pa.DisplayName, &pa.JoinedAt, &pa.LeftAt,
			&audioSec, &videoSec, &ssSec, &speakSec,
			&pa.AvgAudioMOS, &pa.ReconnectCount); err != nil {
			return nil, fmt.Errorf("scan participant: %w", err)
		}

		// Derive duration here rather than with EXTRACT(EPOCH FROM
		// (left_at - joined_at)) in SQL, which is NULL for anyone still
		// connected and takes the whole query down with it.
		leftAt := time.Now()
		if pa.LeftAt != nil {
			leftAt = *pa.LeftAt
		}
		pa.Duration = leftAt.Sub(pa.JoinedAt)
		pa.AudioOnTime = time.Duration(audioSec) * time.Second
		pa.VideoOnTime = time.Duration(videoSec) * time.Second
		pa.ScreenShareTime = time.Duration(ssSec) * time.Second
		pa.SpeakingTime = time.Duration(speakSec) * time.Second

		analytics.Participants = append(analytics.Participants, pa)
	}

	// rows.Err() reports a connection dropped mid-iteration. Without this
	// check a truncated result set is indistinguishable from a short one.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate participants: %w", err)
	}

	summarize(analytics)
	return analytics, nil
}

// summarize computes the meeting-level rollups. Every field it fills is
// one the reporting API advertises. Declaring PeakParticipants and
// ScreenSharePct and never assigning them is not a missing feature, it is
// a reporting API that confidently returns zero.
func summarize(a *MeetingAnalytics) {
	if len(a.Participants) == 0 {
		return
	}

	var totalDur, totalScreenShare time.Duration
	var totalMOS float64
	var audioOnly, reconnected int

	for _, p := range a.Participants {
		totalDur += p.Duration
		totalScreenShare += p.ScreenShareTime
		totalMOS += p.AvgAudioMOS
		if p.VideoOnTime == 0 {
			audioOnly++
		}
		if p.ReconnectCount > 0 {
			reconnected++
		}
	}

	n := float64(len(a.Participants))
	a.AvgDuration = totalDur / time.Duration(len(a.Participants))
	a.AvgAudioQuality = totalMOS / n
	a.AudioOnlyPct = float64(audioOnly) / n * 100
	a.ReconnectRate = float64(reconnected) / n
	if a.TotalDuration > 0 {
		a.ScreenSharePct = float64(totalScreenShare) / float64(a.TotalDuration) * 100
	}
	a.PeakParticipants = peakConcurrent(a.Participants)
}

// peakConcurrent finds the high-water mark of simultaneous participants.
//
// It is not len(Participants): people drift in and out, so twenty distinct
// attendees may never have been in the room together. Sweep the join and
// leave events in time order and track the running count. Sorting the
// events costs O(n log n), against O(n^2) for comparing every pair of
// intervals, which matters for a 1000-person webinar.
func peakConcurrent(ps []ParticipantAnalytics) int {
	type event struct {
		at    time.Time
		delta int
	}
	events := make([]event, 0, 2*len(ps))
	for _, p := range ps {
		events = append(events, event{p.JoinedAt, +1})
		if p.LeftAt != nil {
			events = append(events, event{*p.LeftAt, -1})
		}
	}

	// Ties: process leaves before joins at the same instant, so a handoff
	// where one person leaves exactly as another joins is not counted as
	// two people in the room.
	sort.Slice(events, func(i, j int) bool {
		if events[i].at.Equal(events[j].at) {
			return events[i].delta < events[j].delta
		}
		return events[i].at.Before(events[j].at)
	})

	cur, peak := 0, 0
	for _, e := range events {
		cur += e.delta
		if cur > peak {
			peak = cur
		}
	}
	return peak
}
```

---
