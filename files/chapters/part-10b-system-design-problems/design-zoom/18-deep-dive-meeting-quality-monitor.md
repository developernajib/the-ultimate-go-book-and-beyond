## Deep Dive: Meeting Quality Monitor

Real-time quality monitoring lets support teams detect and diagnose call quality issues before users give up and drop. The `MeetingQualityMonitor` tracks per-participant metrics (MOS audio score, video quality score, packet loss, jitter, and round-trip time) and aggregates them into an overall meeting quality score on a 1-5 scale. When individual metrics cross alert thresholds, such as packet loss above 5% or jitter above 100ms, the monitor surfaces a `QualityIssue` that can trigger automated remediation (such as switching a participant to a lower bitrate layer) or a support notification.

```go
package quality

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// MeetingQualityMonitor tracks real-time quality metrics per meeting
type MeetingQualityMonitor struct {
	meetings map[string]*MeetingQuality
	mu       sync.RWMutex
}

type MeetingQuality struct {
	MeetingID      string
	Participants   map[string]*ParticipantQuality
	OverallScore   float64 // 1-5 stars
	IssuesDetected []QualityIssue
}

type ParticipantQuality struct {
	UserID         string
	AudioQuality   float64 // MOS score 1-5
	VideoQuality   float64 // resolution/framerate score
	PacketLoss     float64 // average %
	Jitter         float64 // average ms
	RTT            float64 // average ms
	BitrateKbps    int
	FrameRate      int
	Resolution     string
	FreezeDuration time.Duration
	AudioDropouts  int
	ReconnectCount int

	// firing records which issue types are currently active for this
	// participant, so a condition that persists for ten minutes produces
	// one issue rather than one per RTCP report.
	firing map[string]bool
}

type QualityIssue struct {
	Type         string // high_packet_loss, high_jitter, audio_dropout, video_freeze, high_latency
	Severity     string // warning, critical
	AffectedUser string
	Message      string
	DetectedAt   time.Time
}

// maxIssuesPerMeeting bounds the retained history. The list is a diagnostic
// aid, not a log of record, and a long meeting on a bad network would
// otherwise grow it without limit.
const maxIssuesPerMeeting = 100

// UpdateParticipantMetrics processes RTCP stats from a participant
func (m *MeetingQualityMonitor) UpdateParticipantMetrics(meetingID, userID string, stats RTCPStats) {
	m.mu.Lock()
	defer m.mu.Unlock()

	meeting, ok := m.meetings[meetingID]
	if !ok {
		meeting = &MeetingQuality{MeetingID: meetingID, Participants: make(map[string]*ParticipantQuality)}
		m.meetings[meetingID] = meeting
	}

	pq, ok := meeting.Participants[userID]
	if !ok {
		pq = &ParticipantQuality{UserID: userID, firing: make(map[string]bool)}
		meeting.Participants[userID] = pq
	}

	// Exponential moving average
	pq.PacketLoss = 0.7*pq.PacketLoss + 0.3*stats.PacketLossRate
	pq.Jitter = 0.7*pq.Jitter + 0.3*stats.JitterMs
	pq.RTT = 0.7*pq.RTT + 0.3*stats.RTTMs
	pq.BitrateKbps = stats.BitrateKbps
	pq.FrameRate = stats.FrameRate
	pq.Resolution = stats.Resolution

	// Compute MOS (Mean Opinion Score) for audio quality
	// ITU-T E-model simplified
	pq.AudioQuality = computeMOS(pq.PacketLoss, pq.Jitter, pq.RTT)

	// Detect quality issues. Each is edge-triggered: raise on the
	// transition into a bad state, clear on the way out. Appending on
	// every report instead would add tens of thousands of near-identical
	// records to a single meeting and page a human for each one.
	meeting.evaluate(pq, "high_packet_loss", pq.PacketLoss > packetLossWarn,
		severity(pq.PacketLoss, packetLossWarn, packetLossCritical),
		fmt.Sprintf("%.1f%% packet loss", pq.PacketLoss*100))

	// Jitter matters independently of loss: packets that all arrive but
	// arrive unevenly still exhaust the jitter buffer and produce audible
	// gaps, so a loss-only check misses a whole class of bad calls.
	meeting.evaluate(pq, "high_jitter", pq.Jitter > jitterWarnMs,
		severity(pq.Jitter, jitterWarnMs, jitterCriticalMs),
		fmt.Sprintf("%.0fms jitter", pq.Jitter))

	meeting.evaluate(pq, "high_latency", pq.RTT > rttWarnMs,
		severity(pq.RTT, rttWarnMs, rttCriticalMs),
		fmt.Sprintf("%.0fms RTT", pq.RTT))

	// Compute overall meeting quality
	totalMOS := 0.0
	for _, p := range meeting.Participants {
		totalMOS += p.AudioQuality
	}
	meeting.OverallScore = totalMOS / float64(len(meeting.Participants))
}

// Alert thresholds. Jitter above 100ms and loss above 5% are the points
// where a call stops sounding merely imperfect and starts breaking up.
const (
	packetLossWarn     = 0.05
	packetLossCritical = 0.15
	jitterWarnMs       = 100
	jitterCriticalMs   = 200
	rttWarnMs          = 300
	rttCriticalMs      = 500
)

// evaluate raises an issue when a condition first becomes true and clears
// it when it goes away. The caller holds the monitor's lock.
func (mq *MeetingQuality) evaluate(pq *ParticipantQuality, issueType string, bad bool, sev, msg string) {
	if !bad {
		delete(pq.firing, issueType)
		return
	}
	if pq.firing[issueType] {
		return // already reported, still true
	}
	pq.firing[issueType] = true

	if len(mq.IssuesDetected) >= maxIssuesPerMeeting {
		// Drop the oldest. Recent issues are what support is looking at.
		mq.IssuesDetected = mq.IssuesDetected[1:]
	}
	mq.IssuesDetected = append(mq.IssuesDetected, QualityIssue{
		Type:         issueType,
		Severity:     sev,
		AffectedUser: pq.UserID,
		Message:      msg,
		DetectedAt:   time.Now(),
	})
}

// EndMeeting drops a finished meeting's metrics. Without it, m.meetings
// retains every meeting the process has ever seen, and the monitor built
// to watch for problems becomes one.
func (m *MeetingQualityMonitor) EndMeeting(meetingID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.meetings, meetingID)
}

// computeMOS maps network conditions to a Mean Opinion Score, the 1-5
// scale a human would give the call. This is a simplified ITU-T G.107
// E-model: it computes an R-value, then converts.
//
// 93.2 is not arbitrary, it is the E-model's R for an impairment-free
// narrowband call, which is why the best MOS this returns is about 4.4 and
// not 5. A monitor that reports 5.0 on a perfect link has not implemented
// the E-model.
func computeMOS(packetLoss, jitter, rtt float64) float64 {
	r := 93.2 - (packetLoss * 100 * 2.5) - (jitter * 0.5) - (rtt * 0.03)
	if r < 0 {
		r = 0
	}
	if r > 100 {
		r = 100
	}
	// R-value to MOS conversion. Valid only for 0 <= R <= 100, hence the
	// clamp above: outside that range the cubic term runs away.
	mos := 1.0 + 0.035*r + r*(r-60)*(100-r)*7e-6
	return math.Max(1.0, math.Min(5.0, mos))
}

func severity(value, warningThreshold, criticalThreshold float64) string {
	if value >= criticalThreshold {
		return "critical"
	}
	return "warning"
}

type RTCPStats struct {
	PacketLossRate float64
	JitterMs       float64
	RTTMs          float64
	BitrateKbps    int
	FrameRate      int
	Resolution     string
}
```

---
