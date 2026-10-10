## Production Go Implementation: Notification Service

When a creator uploads a new video, their subscribers need to be notified. For a creator with 10 million subscribers this is a fan-out problem, and the obvious in-process solution has a bug that deserves its own section, because it is one of the most common ways real Go services silently do nothing.

**Never hand a request-scoped context to a goroutine that outlives the request.** The tempting shape is: read the subscriber list, spawn goroutines over batches, return 202 Accepted immediately. Those goroutines capture `ctx`, and `ctx` is the HTTP request's context. The instant your handler returns, `net/http` cancels it. Every push call in every goroutine then fails with `context.Canceled`, and if the send's error is discarded, which it usually is in this shape, nothing is logged and nothing alerts. The endpoint reports success, the dashboards are clean, and not one subscriber is notified. Run the code and the numbers are stark: of 50,000 notifications, a handful land in the microseconds before cancellation propagates and the rest die. `context.WithoutCancel` (Go 1.21+) detaches the values while dropping the cancellation, or you derive a fresh context with its own timeout.

That fixes the symptom. The deeper problem is the architecture: fanning out 10 million pushes inside the request path is wrong regardless of which context you use. The process can be redeployed mid-fan-out and the work vanishes with no record, `GetActiveSubscribers` pulls 10 million IDs into one process's memory, and 10,000 unbounded goroutines will flatten the push provider. **The right answer is a queue.** The upload handler writes one small "notify subscribers of video X" message and returns. A worker pool consumes it, pages through subscribers, and sends with bounded concurrency, retries, and a dead-letter queue. Durability, backpressure, and observability all come free with the queue and are all things you would otherwise hand-build badly.

The code below is the worker side, after a job has been dequeued. It is the version worth writing: its context is its own, its concurrency is bounded, and it counts what it did.

```go
package notification

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
)

const (
	// Subscribers are paged, not slurped. A 10M-subscriber channel must never
	// become a 10M-element slice in one process's heap.
	pageSize = 1_000
	// Bounded fan-out. The push provider has its own rate limits, and 10,000
	// goroutines is a self-inflicted denial of service against a dependency
	// you do not control.
	sendConcurrency = 64
)

type NotificationService struct {
	pushSvc   PushService
	emailSvc  EmailService
	userStore UserStore
	subStore  SubscriptionStore
	log       *slog.Logger
}

type VideoNotification struct {
	VideoID      string
	Title        string
	UploaderID   string
	UploaderName string
	ThumbnailURL string
	Type         string // "new_upload", "live_stream", "comment_reply"
}

// FanOutResult reports what happened. Returning nothing means an operator has
// no way to tell "notified 9.4M people" from "notified nobody".
type FanOutResult struct {
	Considered int64
	Sent       int64
	Skipped    int64
	Failed     int64
}

// NotifySubscribers fans out one notification job. The ctx here belongs to the
// worker processing the queue message, not to any user's HTTP request, and it
// stays alive for the whole fan-out.
func (s *NotificationService) NotifySubscribers(ctx context.Context, notif VideoNotification) (FanOutResult, error) {
	var res FanOutResult

	sem := make(chan struct{}, sendConcurrency)
	var wg sync.WaitGroup

	var cursor string
	for {
		page, next, err := s.subStore.PageActiveSubscribers(ctx, notif.UploaderID, cursor, pageSize)
		if err != nil {
			wg.Wait()
			return res, fmt.Errorf("page subscribers at cursor %q: %w", cursor, err)
		}

		for _, userID := range page {
			atomic.AddInt64(&res.Considered, 1)

			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				wg.Wait()
				return res, ctx.Err()
			}

			wg.Add(1)
			go func(userID string) {
				defer wg.Done()
				defer func() { <-sem }()

				switch err := s.notifyOne(ctx, userID, notif); {
				case err == errSkipped:
					atomic.AddInt64(&res.Skipped, 1)
				case err != nil:
					atomic.AddInt64(&res.Failed, 1)
					// Log it. A discarded send error is how a totally dead
					// notification pipeline reports perfect health.
					s.log.Error("push failed",
						"user_id", userID, "video_id", notif.VideoID, "error", err)
				default:
					atomic.AddInt64(&res.Sent, 1)
				}
			}(userID)
		}

		if next == "" {
			break
		}
		cursor = next
	}

	wg.Wait()
	return res, nil
}

var errSkipped = fmt.Errorf("notification suppressed by user preference")

func (s *NotificationService) notifyOne(ctx context.Context, userID string, notif VideoNotification) error {
	prefs, err := s.userStore.GetNotificationPrefs(ctx, userID)
	if err != nil {
		// Do not treat "we could not read preferences" as "no preferences set".
		// Defaulting to send would spam users who opted out.
		return fmt.Errorf("get prefs: %w", err)
	}
	if prefs == nil || !prefs.PushEnabled || !prefs.BellEnabled {
		return errSkipped
	}

	return s.pushSvc.Send(ctx, userID, PushMessage{
		Title: fmt.Sprintf("%s uploaded: %s", notif.UploaderName, notif.Title),
		Body:  "Tap to watch",
		Image: notif.ThumbnailURL,
		Data:  map[string]string{"video_id": notif.VideoID, "action": "play"},
	})
}

type PushMessage struct {
	Title string
	Body  string
	Image string
	Data  map[string]string
}
```

If you must kick off background work from inside a handler rather than through a queue, `context.WithoutCancel(ctx)` keeps the request's values, such as the trace ID, while dropping its cancellation, and you then pair it with a timeout of your own:

```go
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// WithoutCancel keeps the request's values (trace IDs, locale) but drops its
	// cancellation, so the goroutine is not killed when this handler returns.
	// The timeout is ours: detaching from the request must not mean running
	// forever.
	bg, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)

	go func() {
		defer cancel()
		if _, err := h.notifier.NotifySubscribers(bg, h.notif); err != nil {
			h.log.Error("fan-out failed", "error", err)
		}
	}()

	w.WriteHeader(http.StatusAccepted)
}
```

Treat that as a stopgap. It survives the response but not a deploy, and a process restart still drops the work on the floor with no record that it was ever owed.

---
