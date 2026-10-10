## Deep Dive: Adaptive Bitrate (ABR) Client Algorithm

Adaptive bitrate streaming is what makes video playback smooth on an unstable connection. The ABR controller runs entirely on the client. It measures how long each segment took to download, estimates available bandwidth with an exponentially weighted moving average, and picks the highest rung the connection can sustain. It also watches the buffer, because bandwidth tells you what you could fetch while the buffer tells you how much time you have before the picture freezes, and only the second one is a deadline.

Four things decide whether an ABR implementation works, and each is a place real players have shipped bugs.

**Measure the client's link, not your own.** The estimate has to come from the player timing its own segment fetches. Timing a fetch that happens server-side measures your datacenter's path to the CDN, which is fast, stable, and completely irrelevant to the viewer on hotel Wi-Fi. This sounds too obvious to get wrong until you see a design where the "bandwidth estimate" is computed somewhere with a 10Gbps NIC.

**Decide what happens before you have measured anything.** The first segment is requested with zero samples in hand. If the cold-start estimate defaults to zero, every session pins to the lowest rung and climbs out slowly or never, so every video opens looking terrible. If it defaults to optimistic, everyone on a weak link rebuffers in the first six seconds. There is no clever answer, only an explicit one: pick a conservative mid rung, say so in the code, and let the first real measurement correct it.

**Know which end of your ladder is index 0.** This is the single most dangerous line in the file. An algorithm written against an ascending ladder, where index 0 is the smallest rung, produces exactly inverted behavior on a descending ladder, and it does so silently, because both are just ints. The emergency "buffer is draining, drop to the safest rung" branch returns index 0, which on a descending ladder is 4K: the code reaches for the fire extinguisher and sprays gasoline. Fix the ambiguity structurally rather than by remembering, which is what the constructor below does by sorting.

**Make sure the buffer level is actually written.** The controller reads `bufferLevel` on the hottest path in the file. If nothing ever assigns it, it sits at Go's zero value forever, every call takes the low-buffer branch, and the bandwidth estimator you carefully built is dead code that no decision consults. State that is read but never written is the quietest bug class in this chapter: it compiles, it runs, it looks right in review, and the only symptom is that the system's behavior never changes no matter what the network does.

```go
package abr

import (
	"sort"
	"time"
)

const (
	// Below this many seconds buffered, rebuffering is imminent and nothing
	// matters except getting the next segment in. Drop to the bottom rung.
	panicBufferSecs = 5.0
	// Above this, the buffer is comfortable enough to gamble on an upshift.
	safeBufferSecs = 20.0
	// Only spend this share of measured bandwidth. The headroom absorbs the
	// error in the estimate and the fact that bitrates are averages: a
	// high-motion scene at a "5 Mbps" rung can burst well above 5 Mbps.
	bandwidthSafetyFactor = 0.7
	// Cold-start estimate, used until the first segment has been measured.
	// Deliberately conservative: too low and every stream opens at 240p, too
	// high and every weak link rebuffers on segment one.
	coldStartBPS = 1_500_000
	ewmaAlpha    = 0.3
	maxSamples   = 20
)

type QualityLevel struct {
	Name       string
	BitrateBPS int
	Width      int
	Height     int
}

type BandwidthSample struct {
	BytesDownloaded int
	Duration        time.Duration
}

// ABRController picks a rung per segment. It is driven by the player and is not
// safe for concurrent use: the player calls it from one place, in one order.
type ABRController struct {
	// ladder is sorted ASCENDING by bitrate, so index 0 is the lowest rung and
	// len-1 is the highest. The constructor guarantees this rather than trusting
	// the caller, because every comparison below encodes the assumption and a
	// reversed ladder inverts all of them without a single compile error.
	ladder            []QualityLevel
	samples           []BandwidthSample
	bufferSecs        float64
	currentQuality    int
	lastSwitchTime    time.Time
	minSwitchInterval time.Duration
}

func NewABRController(ladder []QualityLevel, minSwitchInterval time.Duration) *ABRController {
	sorted := make([]QualityLevel, len(ladder))
	copy(sorted, ladder)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].BitrateBPS < sorted[j].BitrateBPS
	})
	return &ABRController{
		ladder:            sorted,
		minSwitchInterval: minSwitchInterval,
		// Start one rung above the bottom when there is more than one rung, so
		// the opening seconds are watchable without betting on a fast link.
		currentQuality: min(1, len(sorted)-1),
	}
}

// NotifyBuffer is how the buffer level gets into this controller. Without it
// bufferSecs stays at 0 forever and SelectQuality permanently takes the panic
// branch. The player must call this whenever its buffer occupancy changes.
func (c *ABRController) NotifyBuffer(seconds float64) {
	c.bufferSecs = seconds
}

// RecordSegmentDownload logs one completed segment fetch. The caller times the
// client's own request, start to finish, which is the only measurement that
// describes the viewer's actual link.
func (c *ABRController) RecordSegmentDownload(bytes int, d time.Duration) {
	if bytes <= 0 || d <= 0 {
		return // a zero duration would divide to +Inf and blow up the EWMA
	}
	c.samples = append(c.samples, BandwidthSample{BytesDownloaded: bytes, Duration: d})
	if len(c.samples) > maxSamples {
		c.samples = c.samples[len(c.samples)-maxSamples:]
	}
}

func (c *ABRController) SelectQuality() int {
	// Buffer first. It is a deadline, and no bandwidth estimate outranks it.
	if c.bufferSecs < panicBufferSecs {
		c.currentQuality = 0 // index 0 is the LOWEST rung, guaranteed by the constructor
		c.lastSwitchTime = time.Now()
		return c.currentQuality
	}

	estimatedBPS := c.estimateBandwidth()
	budget := estimatedBPS * bandwidthSafetyFactor

	// Highest rung whose bitrate fits the budget. Ascending ladder, so keep
	// walking up while it fits. Index 0 is the floor: if nothing fits we still
	// have to play something.
	target := 0
	for i, q := range c.ladder {
		if float64(q.BitrateBPS) <= budget {
			target = i
		}
	}

	switch {
	case target < c.currentQuality:
		// Downshift immediately and by as many rungs as needed. Rebuffering is
		// far worse than a visible quality drop, so this path gets no hysteresis
		// and no step limit.
	case target > c.currentQuality:
		// Upshift is a bet: we are claiming the link will still be this good
		// six seconds from now. Require a healthy buffer to cover being wrong,
		// rate-limit the switches, and climb one rung at a time.
		if c.bufferSecs < safeBufferSecs || time.Since(c.lastSwitchTime) < c.minSwitchInterval {
			return c.currentQuality
		}
		target = c.currentQuality + 1
	default:
		return c.currentQuality
	}

	c.currentQuality = target
	c.lastSwitchTime = time.Now()
	return c.currentQuality
}

// estimateBandwidth returns the EWMA of recent throughput, in bits per second.
func (c *ABRController) estimateBandwidth() float64 {
	if len(c.samples) == 0 {
		return coldStartBPS
	}
	ewma := 0.0
	for i, s := range c.samples {
		bps := float64(s.BytesDownloaded*8) / s.Duration.Seconds()
		if i == 0 {
			ewma = bps
		} else {
			ewma = ewmaAlpha*bps + (1-ewmaAlpha)*ewma
		}
	}
	return ewma
}
```

The EWMA above is a throughput estimator, and it is worth knowing its weakness before you defend it in an interview. It reacts to a link that got slower only after several segments have already been slow, which on a 6-second segment is half a minute of degraded measurement. That is why production players do not rely on throughput alone. Buffer-based approaches such as BOLA choose the rung from buffer occupancy directly, on the reasoning that the buffer is ground truth about whether you are keeping up, while a throughput estimate is a guess about the future. The controller here is a hybrid, which is what most shipping players are: throughput proposes, buffer vetoes.

---
