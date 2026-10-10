## Deep Dive: Notification Fan-Out

When someone mentions you in a tweet, likes your post, or retweets your content, you expect a notification within seconds. The Notification Service listens for engagement events from Kafka and delivers them through two channels: an in-app notification stored in the database, and a push notification via Firebase Cloud Messaging (FCM) or Apple Push Notification Service (APNs).

Two details in this code are worth more attention than they usually get. The first is that the recipient of a notification is the *author* of the tweet, not the tweet itself, and not the person who acted. It reads as obvious and it is a genuinely common bug, because the like event carries a tweet ID and the tweet ID is right there, ready to be passed into the recipient slot. Every notification below names its fields explicitly for exactly that reason: a positional struct literal makes swapping the actor and the recipient a silent mistake that compiles.

The second is that Kafka gives you at-least-once delivery, so this consumer will see the same like event more than once. Without a dedupe key, every redelivery is another buzz on someone's phone. The `dedupe_key` unique constraint turns a replay into a no-op insert.

```go
package notification

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"unicode/utf8"
)

type NotificationService struct {
	db    NotificationStore
	conn  ConnectionRouter
	push  PushService
	users UserDirectory
}

type Notification struct {
	RecipientID int64  // who gets the buzz: the tweet author, never the tweet
	Type        string // "mention", "like", "retweet"
	ActorID     int64  // who caused it
	TweetID     *int64
	Text        string
	DedupeKey   string // UNIQUE in the DB: makes a Kafka replay a no-op
}

func (s *NotificationService) NotifyMentions(ctx context.Context, tweet Tweet) error {
	for _, mention := range tweet.Mentions {
		uid, err := s.users.ResolveUsername(ctx, mention)
		if errors.Is(err, ErrUserNotFound) {
			continue // "@notarealuser" is text, not a mention
		}
		if err != nil {
			return fmt.Errorf("resolve %q: %w", mention, err)
		}
		if uid == tweet.UserID {
			continue // do not notify people about their own tweets
		}

		n := Notification{
			RecipientID: uid,
			Type:        "mention",
			ActorID:     tweet.UserID,
			TweetID:     &tweet.ID,
			Text:        fmt.Sprintf("mentioned you: %s", truncateRunes(tweet.Text, 100)),
			DedupeKey:   fmt.Sprintf("mention:%d:%d", tweet.ID, uid),
		}
		if err := s.deliver(ctx, n, "New mention"); err != nil {
			return err
		}
	}
	return nil
}

func (s *NotificationService) NotifyLike(ctx context.Context, likerID, authorID, tweetID int64) error {
	if likerID == authorID {
		return nil // liking your own tweet is not news
	}
	n := Notification{
		RecipientID: authorID, // the author, not the tweet and not the liker
		Type:        "like",
		ActorID:     likerID,
		TweetID:     &tweetID,
		Text:        "liked your tweet",
		DedupeKey:   fmt.Sprintf("like:%d:%d", tweetID, likerID),
	}
	return s.deliver(ctx, n, "New like")
}

func (s *NotificationService) deliver(ctx context.Context, n Notification, title string) error {
	// The DB write is the durable record and the source of the dedupe decision.
	// If the key already exists this is a replay, so stop here rather than
	// buzzing the phone a second time.
	inserted, err := s.db.CreateIfAbsent(ctx, n)
	if err != nil {
		return fmt.Errorf("persist notification: %w", err)
	}
	if !inserted {
		return nil
	}

	// Delivery is best effort on top of a durable record. A dropped websocket
	// frame or a failed push must not fail the Kafka message and force a
	// redelivery, because the notification is already stored and the user will
	// see it on their next fetch.
	if err := s.conn.DeliverToUser(ctx, fmt.Sprint(n.RecipientID), n); err != nil {
		slog.WarnContext(ctx, "websocket delivery failed", "recipient", n.RecipientID, "error", err)
	}
	if err := s.push.Send(ctx, n.RecipientID, title, n.Text); err != nil {
		slog.WarnContext(ctx, "push delivery failed", "recipient", n.RecipientID, "error", err)
	}
	return nil
}

// truncateRunes cuts to n runes, not n bytes. Slicing a tweet at Text[:100]
// splits whatever multi-byte rune straddles the boundary and emits a broken
// character, which shows up the moment anyone tweets in a non-Latin script.
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i] + "…"
		}
		count++
	}
	return s
}
```

For high-volume events like likes on a viral tweet, delivering one notification per like is its own denial of service: a tweet with 2M likes would mean 2M rows and 2M pushes aimed at one phone. Production systems collapse these into a rollup ("X and 50 others liked your tweet") by writing the like into a per-tweet aggregate and pushing on a decaying schedule rather than on every event. That path is a coalescing problem rather than a fan-out problem, and it is worth naming in an interview even when you do not have time to design it.

---
