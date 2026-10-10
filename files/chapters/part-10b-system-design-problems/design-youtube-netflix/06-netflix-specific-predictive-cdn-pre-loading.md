## Netflix-Specific: Predictive CDN Pre-Loading

Netflix operates its own CDN, Open Connect, with appliances (OCAs) physically installed inside ISP data centers around the world. Instead of waiting for users to request content and then caching it reactively, Netflix predicts what will be popular in each region and pushes it to the appliances during a nightly off-peak fill window. Netflix's published guidance for partners recommends a 10 to 12 hour window, typically 2AM to noon local time, at up to 1.2Gbps per appliance. Note how long that window is: this is a slow, deliberate, bandwidth-limited process, not a burst.

The approach works because Netflix has a bounded catalog, tens of thousands of titles globally, against YouTube's hundreds of millions of videos, and because viewing is predictable enough that yesterday's model is a good guide to tonight's demand. Get the fill right and the appliance answers essentially every request locally, so the ISP carries no upstream traffic and Netflix pays no transit.

The strategic insight is worth more than the algorithm. Reactive caching turns a cache miss into a user-visible latency event. Predictive fill turns it into a capacity planning problem you solve at 4AM with nobody watching. YouTube cannot copy this, and not because it lacks the engineering: with hundreds of millions of videos and a long tail where an obscure video may be watched twice this year in one country, there is nothing to predict. Bounded catalog is what buys Netflix the option. When you reach for a technique in an interview, be able to say which property of the problem makes it available to you.

```go
package cdn

import (
	"sort"
)

// Open Connect is Netflix's own CDN, embedded inside ISP data centers.
// Strategy: preload predicted-popular content during the nightly fill window.

// PopCache tracks which content is cached at a Point of Presence
type PopCache struct {
	Location   string
	Region     string
	Videos     map[string]bool
	StorageGB  float64
	CapacityGB float64
}

// ContentScore ranks content by value density for a given PoP
type ContentScore struct {
	VideoID        string
	PredictedViews float64
	SizeMB         float64
	ValueScore     float64 // views-per-MB: cache efficiency metric
}

// PredictiveLoader pre-loads content to edge nodes during off-peak
type PredictiveLoader struct {
	pops      []*PopCache
	predictor PopularityPredictor
}

// SelectContentToCache decides what to preload for a PoP.
// Algorithm: maximize expected cache hits per MB of storage, greedy knapsack.
func (p *PredictiveLoader) SelectContentToCache(pop *PopCache, availableGB float64) []string {
	candidates := p.predictor.GetPredictedHits(pop.Region, 1000)

	scores := make([]ContentScore, 0, len(candidates))
	for _, c := range candidates {
		if pop.Videos[c.VideoID] {
			continue // already cached
		}
		// A zero or negative size is bad data, not a free video. Dividing by it
		// yields +Inf, which sorts to the front and lets one corrupt row
		// monopolize the fill list.
		if c.SizeMB <= 0 {
			continue
		}
		scores = append(scores, ContentScore{
			VideoID:        c.VideoID,
			PredictedViews: c.PredictedViews,
			SizeMB:         c.SizeMB,
			ValueScore:     c.PredictedViews / c.SizeMB,
		})
	}

	// Sort by value density descending.
	sort.Slice(scores, func(i, j int) bool {
		return scores[i].ValueScore > scores[j].ValueScore
	})

	var selected []string
	remaining := availableGB * 1000 // GB → MB, decimal to match SizeMB
	for _, s := range scores {
		// Skip, do not break. Breaking on the first item too large to fit
		// abandons the rest of the list, so a single 4K feature film near the
		// top of the ranking leaves the appliance half empty for the night.
		if s.SizeMB > remaining {
			continue
		}
		selected = append(selected, s.VideoID)
		remaining -= s.SizeMB
	}
	return selected
}
```

---
