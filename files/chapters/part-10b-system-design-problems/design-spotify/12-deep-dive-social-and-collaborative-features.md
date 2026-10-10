## Deep Dive: Social and Collaborative Features

Social features like "Friend Activity" (seeing what your friends are listening to right now) and collaborative playlists are key differentiators. The social service keeps this state in Redis because the sidebar should update within a second or two of a friend pressing play.

The interesting decision is fan-out-on-write versus fan-out-on-read, and Friend Activity is one of the rare cases where the usual answer inverts. A timeline is normally fanned out on write, because a post is written once and read by many, and you would rather pay the cost once. Friend Activity has the opposite shape. Users change tracks every three minutes, so writes are constant, while the sidebar is only read when someone actually looks at it, which is rarely. Fanning out on write means every track change on the platform writes to every follower's feed, and a user with a million followers generates a million writes every three minutes for a panel almost nobody has open. So this service stores exactly one "currently playing" hash per user and assembles the sidebar on read. The read is bounded because it is scoped to who you follow, not who follows you, and that number is small for essentially everyone.

That asymmetry is the general rule worth carrying out of here: fan out on write when the fan-out factor is bounded and reads outnumber writes, fan out on read when the fan-out factor is unbounded (celebrities) or writes outnumber reads. Friend Activity is both of the latter at once.

Note the pipelining. The naive version issues one round trip per followed user, so a 200-friend sidebar costs 200 sequential RTTs and takes a visible fraction of a second on network latency alone, even though Redis itself answers each one in microseconds. One pipelined batch costs one round trip.

```go
package social

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

type SocialService struct {
	rdb *redis.Client
}

type ListeningActivity struct {
	UserID, TrackID, TrackName, ArtistName string
	StartedAt                              time.Time
}

// activityTTL bounds staleness. If a client dies without sending a stop, the
// hash expires on its own and the friend quietly drops off the sidebar rather
// than appearing to listen to the same song for eternity.
const activityTTL = 30 * time.Minute

// PublishActivity records what one user is playing right now. Constant cost,
// independent of follower count.
func (s *SocialService) PublishActivity(ctx context.Context, a ListeningActivity) error {
	key := fmt.Sprintf("activity:current:%s", a.UserID)

	// HSet and Expire in one round trip. Errors are checked: dropping them
	// leaves the sidebar showing a stale track with no signal that it is stale.
	pipe := s.rdb.TxPipeline()
	pipe.HSet(ctx, key,
		"track_id", a.TrackID,
		"track_name", a.TrackName,
		"artist_name", a.ArtistName,
		"started_at", a.StartedAt.Unix(),
	)
	pipe.Expire(ctx, key, activityTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("publish activity for %s: %w", a.UserID, err)
	}
	return nil
}

// GetFriendActivity assembles the sidebar for one user on read.
func (s *SocialService) GetFriendActivity(ctx context.Context, userID string) ([]ListeningActivity, error) {
	following, err := s.rdb.SMembers(ctx, fmt.Sprintf("user:following:%s", userID)).Result()
	if err != nil {
		return nil, fmt.Errorf("load following for %s: %w", userID, err)
	}

	// One round trip for every friend, not one per friend.
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.MapStringStringCmd, len(following))
	for i, fid := range following {
		cmds[i] = pipe.HGetAll(ctx, fmt.Sprintf("activity:current:%s", fid))
	}
	// Exec reports the first command error. Missing keys are not errors, they
	// come back as empty maps, which is the common case: most friends are not
	// listening right now.
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, fmt.Errorf("load friend activity: %w", err)
	}

	activities := make([]ListeningActivity, 0, len(following))
	for i, cmd := range cmds {
		data := cmd.Val()
		if len(data) == 0 {
			continue // not currently listening, or the hash expired
		}
		// StartedAt round-trips through the hash. Skipping this is a silent
		// bug: the field stays zero and the UI renders "listening since 1970".
		var startedAt time.Time
		if secs, err := strconv.ParseInt(data["started_at"], 10, 64); err == nil {
			startedAt = time.Unix(secs, 0)
		}
		activities = append(activities, ListeningActivity{
			UserID:     following[i],
			TrackID:    data["track_id"],
			TrackName:  data["track_name"],
			ArtistName: data["artist_name"],
			StartedAt:  startedAt,
		})
	}
	return activities, nil
}
```

---
