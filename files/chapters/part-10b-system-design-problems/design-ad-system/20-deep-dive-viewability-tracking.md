## Deep Dive: Viewability Tracking

Viewability tracking determines whether an ad was actually seen by a human user, not just loaded in the background or below the fold. The IAB (Interactive Advertising Bureau) standard requires that at least 50% of a display ad's pixels are visible in the viewport for at least 1 second, or 2 seconds for video ads. This matters because many advertisers now pay only for viewable impressions (vCPM pricing model), so accurate viewability measurement directly impacts revenue. The client-side JavaScript uses the IntersectionObserver API to detect when the ad enters the viewport, and reports events to the server via Kafka for processing.

```go
package viewability

import (
	"context"
	"encoding/json"

	"github.com/twmb/franz-go/pkg/kgo"
)

// ViewabilityTracker determines if an ad was actually seen by the user
// IAB/MRC standard: at least 50% of pixels visible for >= 1 second (display)
// Video: at least 50% of pixels visible for >= 2 seconds of continuous play
type ViewabilityTracker struct {
	kafka *kgo.Client
}

// ViewabilityEvent is reported by the client-side JavaScript
type ViewabilityEvent struct {
	ImpressionID    string  `json:"impression_id"`
	AdID            string  `json:"ad_id"`
	CampaignID      string  `json:"campaign_id"`
	PercentVisible  float64 `json:"percent_visible"`  // 0.0 - 1.0
	DurationVisibleMs int   `json:"duration_visible_ms"`
	InViewport      bool    `json:"in_viewport"`
	VideoPlayed     bool    `json:"video_played"`
	AudioEnabled    bool    `json:"audio_enabled"`
	PageScrollDepth float64 `json:"page_scroll_depth"`
	WindowFocused   bool    `json:"window_focused"`
	Timestamp       int64   `json:"timestamp"`
}

// ViewabilityResult classifies whether the impression was viewable
type ViewabilityResult struct {
	IsViewable      bool   `json:"is_viewable"`
	Classification  string `json:"classification"` // viewable, non_viewable, undetermined
	Reason          string `json:"reason"`
}

// Classify determines viewability based on IAB MRC standards
func Classify(event ViewabilityEvent) ViewabilityResult {
	// Window not focused = not viewable, regardless of geometry
	if !event.WindowFocused {
		return ViewabilityResult{IsViewable: false, Classification: "non_viewable", Reason: "window_not_focused"}
	}

	// Display ad: >= 50% pixels visible for >= 1 second
	if !event.VideoPlayed {
		if event.PercentVisible >= 0.50 && event.DurationVisibleMs >= 1000 {
			return ViewabilityResult{IsViewable: true, Classification: "viewable", Reason: "display_50pct_1sec"}
		}
		if event.PercentVisible < 0.50 {
			return ViewabilityResult{IsViewable: false, Classification: "non_viewable", Reason: "below_50pct_visible"}
		}
		if event.DurationVisibleMs < 1000 {
			return ViewabilityResult{IsViewable: false, Classification: "non_viewable", Reason: "below_1sec_duration"}
		}
	}

	// Video ad: >= 50% pixels visible for >= 2 seconds
	if event.VideoPlayed {
		if event.PercentVisible >= 0.50 && event.DurationVisibleMs >= 2000 {
			return ViewabilityResult{IsViewable: true, Classification: "viewable", Reason: "video_50pct_2sec"}
		}
		return ViewabilityResult{IsViewable: false, Classification: "non_viewable", Reason: "video_below_threshold"}
	}

	return ViewabilityResult{IsViewable: false, Classification: "undetermined", Reason: "insufficient_data"}
}

// ProcessViewabilityEvents reads from Kafka and updates impression records
func (t *ViewabilityTracker) ProcessViewabilityEvents(ctx context.Context) {
	for {
		fetches := t.kafka.PollFetches(ctx)
		fetches.EachRecord(func(r *kgo.Record) {
			var event ViewabilityEvent
			if err := json.Unmarshal(r.Value, &event); err != nil {
				return
			}
			result := Classify(event)

			// Update impression record with viewability status
			// Used for billing: some advertisers only pay for viewable impressions (vCPM)
			t.updateImpressionViewability(ctx, event.ImpressionID, result)
		})
	}
}

func (t *ViewabilityTracker) updateImpressionViewability(ctx context.Context, impID string, result ViewabilityResult) {
	// Update ClickHouse impression record
}
```

---
