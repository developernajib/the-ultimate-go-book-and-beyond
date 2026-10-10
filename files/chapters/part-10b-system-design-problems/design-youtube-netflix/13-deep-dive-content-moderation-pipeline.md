## Deep Dive: Content Moderation Pipeline

Content moderation is a regulatory and legal requirement for any user-generated content platform. This pipeline runs three analyzers in parallel using goroutines: visual analysis (violence, nudity, harmful imagery), audio analysis (hate speech, copyrighted music), and copyright checking against a fingerprint database. Running them concurrently keeps wall-clock time near the slowest analyzer rather than the sum of all three.

The decision logic is where this gets interesting, and where the obvious implementation is dangerously wrong. The tempting version takes the maximum confidence across all labels and rejects above some threshold. Think about what that actually says. These analyzers emit a label and a confidence that **the label applies**, so a video the visual analyzer is 99% certain contains a *cat* scores 0.99 and gets auto-rejected alongside genuine abuse. Confidence is not severity. They are different axes and collapsing them into one number produces a system that removes creators' videos for containing recognizable objects. What you need is a per-category policy: what this label means, and how sure we must be before acting on it.

The second thing to get right is that a moderation verdict must always move the video out of its pending state. An outcome that decides "a human should look at this" and then fails to record that decision anywhere leaves the video stuck in `processing` forever, invisible to the uploader and to the review queue alike. Every branch has to write.

```go
package moderation

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type Verdict string

const (
	VerdictApproved Verdict = "approved"
	VerdictFlagged  Verdict = "flagged" // needs a human
	VerdictRejected Verdict = "rejected"
)

type ModerationResult struct {
	VideoID     string
	Verdict     Verdict
	Reason      string         // the label that drove the verdict, for the appeal
	Labels      []ContentLabel // everything we saw, for auditability
	CompletedAt time.Time
}

type ContentLabel struct {
	Category   string  // "nudity", "violence", "cat", "copyright_match", ...
	Confidence float64 // how sure we are the label applies, NOT how bad it is
	Timestamp  float64 // seconds into the video
}

// Policy maps a category to what we are willing to do about it and how certain
// we must be first. A category with no policy entry is informational: we record
// it and take no action. This is what stops a 0.99-confidence "cat" from being
// treated like a 0.99-confidence "csam".
type Policy struct {
	RejectAbove float64 // auto-remove at or above this confidence
	FlagAbove   float64 // send to human review at or above this confidence
}

var policies = map[string]Policy{
	"csam":             {RejectAbove: 0.50, FlagAbove: 0.20}, // lowest bar, always escalate
	"nudity":           {RejectAbove: 0.95, FlagAbove: 0.70},
	"graphic_violence": {RejectAbove: 0.97, FlagAbove: 0.75},
	"hate_speech":      {RejectAbove: 0.98, FlagAbove: 0.70},
	// A copyright hit is never an auto-removal: the rights holder chooses the
	// policy and the uploader can dispute. Route it to the claims flow instead.
	"copyright_match": {RejectAbove: 2.0, FlagAbove: 0.90},
}

type ModerationPipeline struct {
	visualAnalyzer   VisualAnalyzer
	audioAnalyzer    AudioAnalyzer
	copyrightChecker CopyrightChecker
	videoDB          VideoStore
}

func (p *ModerationPipeline) Analyze(ctx context.Context, videoID, rawKey string) (*ModerationResult, error) {
	// Cancel the siblings as soon as one analyzer fails: their work is wasted.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var (
		mu       sync.Mutex
		all      []ContentLabel
		firstErr error
		wg       sync.WaitGroup
	)

	run := func(name string, fn func(context.Context, string) ([]ContentLabel, error)) {
		defer wg.Done()
		labels, err := fn(ctx, rawKey)

		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", name, err)
				cancel()
			}
			return
		}
		all = append(all, labels...)
	}

	wg.Add(3)
	go run("visual", p.visualAnalyzer.Analyze)
	go run("audio", p.audioAnalyzer.Analyze)
	go run("copyright", p.copyrightChecker.Check)
	wg.Wait()

	// Fail closed. An analyzer that errored saw nothing, and "we did not look"
	// must never be recorded as "we looked and it was fine".
	if firstErr != nil {
		return nil, fmt.Errorf("moderation failed, video stays unpublished: %w", firstErr)
	}

	result := &ModerationResult{
		VideoID:     videoID,
		Verdict:     VerdictApproved,
		Labels:      all,
		CompletedAt: time.Now(),
	}

	// Evaluate each label against its own category's policy and keep the most
	// severe outcome. Severity, not confidence, decides.
	for _, l := range all {
		pol, ok := policies[l.Category]
		if !ok {
			continue // informational label, no action
		}
		switch {
		case l.Confidence >= pol.RejectAbove:
			result.Verdict = VerdictRejected
			result.Reason = l.Category
			// Nothing outranks a rejection, stop looking.
			return result, p.commit(ctx, result)
		case l.Confidence >= pol.FlagAbove && result.Verdict == VerdictApproved:
			result.Verdict = VerdictFlagged
			result.Reason = l.Category
		}
	}

	return result, p.commit(ctx, result)
}

// commit records the verdict. Every branch writes: a flagged video that never
// leaves "processing" is invisible to both the uploader and the review queue.
func (p *ModerationPipeline) commit(ctx context.Context, r *ModerationResult) error {
	var status string
	switch r.Verdict {
	case VerdictApproved:
		status = "ready"
	case VerdictFlagged:
		status = "under_review"
	case VerdictRejected:
		status = "removed"
	}
	if err := p.videoDB.UpdateStatus(ctx, r.VideoID, status); err != nil {
		return fmt.Errorf("record verdict %s for %s: %w", r.Verdict, r.VideoID, err)
	}
	return nil
}
```

---
