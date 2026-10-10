## Deep Dive: Adaptive Bitrate Controller

Adaptive bitrate is the mechanism that keeps video calls smooth even when a participant's network degrades. The SFU constantly receives RTCP (Real-time Transport Control Protocol) feedback from each subscriber reporting packet loss, jitter, and round-trip time. The controller uses an exponential moving average to smooth out momentary spikes and only switches quality layers when the trend is clear, preventing annoying flickering between resolutions. The hysteresis thresholds (different values for upgrading vs downgrading) ensure the system does not oscillate rapidly between quality levels.

```go
package sfu

import (
	"math"
	"sync"
	"time"
)

// keyframeCooldown throttles PLI requests. Every layer switch needs a
// keyframe, but a keyframe is a large, expensive frame: asking for them
// faster than this turns a congested link into a more congested one.
const keyframeCooldown = 1 * time.Second

type AdaptiveBitrateController struct {
	subscribers map[string]*SubscriberBW
	mu          sync.RWMutex

	// requestLayer applies a decision: it repoints the subscriber at a new
	// simulcast layer and asks the publisher for a keyframe on it. Without
	// a hook like this the controller computes a layer, stores it, and
	// changes nothing about what the SFU actually forwards.
	requestLayer func(subID, layer string)
}

type SubscriberBW struct {
	UserID         string
	PacketLossRate float64
	Jitter, RTT    float64
	CurrentLayer   string
	LastKeyframe   time.Time
	QualityHistory []float64
}

func (c *AdaptiveBitrateController) ProcessRTCPFeedback(subID string, lost, received int, jitter, rtt float64) {
	c.mu.Lock()
	defer c.mu.Unlock()

	sub, ok := c.subscribers[subID]
	if !ok {
		return
	}

	// RTCP receiver reports carry cumulative lost and received counts, so
	// the denominator is everything that was sent, not just what arrived.
	var lossRate float64
	if received+lost > 0 {
		lossRate = float64(lost) / float64(received+lost)
	}

	// Smooth each input first. One bad report is a blip, not a trend.
	sub.PacketLossRate = 0.7*sub.PacketLossRate + 0.3*lossRate
	sub.Jitter = 0.7*sub.Jitter + 0.3*jitter
	sub.RTT = 0.7*sub.RTT + 0.3*rtt

	score := (1.0-sub.PacketLossRate)*0.5 +
		math.Max(0, 1.0-sub.Jitter/100)*0.3 +
		math.Max(0, 1.0-sub.RTT/500)*0.2

	sub.QualityHistory = append(sub.QualityHistory, score)
	if len(sub.QualityHistory) > 30 {
		sub.QualityHistory = sub.QualityHistory[1:]
	}

	avg := average(sub.QualityHistory)

	// Order matters: test the worst case first. Writing the "high" arm as
	// `if avg < 0.6 { medium } else if avg < 0.3 { low }` makes the second
	// branch unreachable, because any avg below 0.3 is already below 0.6.
	// A subscriber whose network collapses would step down to medium and
	// stop there, still trying to push 360p over a link carrying nothing.
	newLayer := sub.CurrentLayer
	switch sub.CurrentLayer {
	case "high":
		switch {
		case avg < 0.3:
			newLayer = "low"
		case avg < 0.6:
			newLayer = "medium"
		}
	case "medium":
		switch {
		case avg < 0.4:
			newLayer = "low"
		case avg > 0.85:
			newLayer = "high"
		}
	case "low":
		if avg > 0.8 {
			newLayer = "medium"
		}
	}

	// The thresholds are deliberately asymmetric: leave medium upward only
	// above 0.85, but drop out of high already at 0.6. The gap is the
	// hysteresis band that stops the layer from flapping when the score
	// hovers on a boundary. Degrade eagerly, recover cautiously.
	if newLayer == sub.CurrentLayer {
		return
	}
	if time.Since(sub.LastKeyframe) < keyframeCooldown {
		return
	}

	sub.CurrentLayer = newLayer
	sub.LastKeyframe = time.Now()
	if c.requestLayer != nil {
		c.requestLayer(subID, newLayer)
	}
}

func average(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := 0.0
	for _, x := range v {
		s += x
	}
	return s / float64(len(v))
}
```

One caveat worth raising before an interviewer raises it: this controller infers congestion from loss, jitter, and RTT, which is a lagging signal. Loss means the queue already overflowed. Production WebRTC pairs this with Google Congestion Control, which watches the *arrival-time gradient* of packets through transport-wide congestion control feedback (`transport-cc`) and detects a queue building before it spills. Loss-based control is the floor, not the state of the art.

---
