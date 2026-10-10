## Failure Handling

In a distributed system at this scale, failures are not exceptional, they are routine. The fan-out pool below demonstrates a key resilience pattern: Kafka consumer workers that only commit an offset after successfully writing to Redis. If a write fails, the message stays on the topic and gets retried. Because Redis `ZADD` is idempotent, adding the same tweet ID twice updates the score to the same value and changes nothing, so a retry cannot duplicate an entry in anyone's timeline.

The discipline that makes this work is refusing to commit an offset you have not earned. Every swallowed error in a consumer loop is a chance to commit past a message you never processed, and a tweet that reaches nobody is invisible: no error surfaces, no alert fires, and the author sees their own tweet on their own profile. Note that `GetFollowers` returning an error and returning an empty list are indistinguishable if you drop the error, and fanning out to an empty list "succeeds", which commits the offset and loses the tweet permanently.

The other habit worth copying is the backoff. A `continue` on a poll error turns the worker into a spin loop that pins a core the moment Kafka is unreachable, which is precisely when you need the box to stay responsive.

```go
package fanout

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"
)

type FanOutPool struct {
	workers  int
	kafka    KafkaConsumer
	timeline *TimelineService
}

func (p *FanOutPool) Start(ctx context.Context) {
	for i := 0; i < p.workers; i++ {
		go p.loop(ctx)
	}
}

func (p *FanOutPool) loop(ctx context.Context) {
	backoff := time.Second
	const maxBackoff = 30 * time.Second

	for {
		if ctx.Err() != nil {
			return
		}

		msg, err := p.kafka.Poll(ctx)
		if err != nil {
			// Back off instead of spinning. A bare continue here burns a full
			// core for as long as the broker is unreachable.
			slog.WarnContext(ctx, "kafka poll failed", "error", err, "backoff", backoff)
			if !sleepCtx(ctx, backoff) {
				return
			}
			backoff = min(backoff*2, maxBackoff)
			continue
		}
		backoff = time.Second

		tweet, err := parseTweet(msg)
		if err != nil {
			// A message we can never parse will never parse. Retrying it
			// forever blocks the partition, so park it and move on.
			slog.ErrorContext(ctx, "poison message, routing to DLQ", "error", err)
			p.kafka.SendToDLQ(ctx, msg)
			p.kafka.Commit(ctx, msg)
			continue
		}

		// FanOut owns the celebrity check and the follower lookup, so the
		// threshold lives in exactly one place. Any error means the tweet has
		// not been delivered, so the offset stays put and Kafka redelivers.
		if err := p.timeline.FanOut(ctx, tweet); err != nil {
			slog.ErrorContext(ctx, "fan-out failed, not committing", "tweet", tweet.ID, "error", err)
			continue
		}
		p.kafka.Commit(ctx, msg)
	}
}

// sleepCtx reports false if the context ended before the sleep finished.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func parseTweet(m Message) (Tweet, error) {
	var t Tweet
	if err := json.Unmarshal(m.Value, &t); err != nil {
		return Tweet{}, err
	}
	if t.ID == 0 || t.UserID == 0 {
		// Without this the zero value flows on and every follower of user 0
		// gets a tweet that does not exist.
		return Tweet{}, errors.New("tweet missing id or user_id")
	}
	return t, nil
}
```

| Failure | Degradation |
|---------|-------------|
| Redis cache down | Rebuild from DB |
| Kafka backlog | Timeline stale by seconds |
| Elasticsearch down | Disable search |
| Trending lag | Cached trends |
| Celebrity cache miss | Pull from DB |

---
