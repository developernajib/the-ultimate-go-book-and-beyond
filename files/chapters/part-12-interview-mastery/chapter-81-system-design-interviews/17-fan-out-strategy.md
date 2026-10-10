## Fan-out Strategy

### Problem: Celebrity Problem
- Justin Bieber: 100M followers
- Fan-out on write: Each tweet writes to 100M timelines
- At 5800 TPS × 100M = Impossible

### Solution: Hybrid Approach

**Regular Users (< 10K followers): Fan-out on Write**
```
User posts tweet
     │
     ▼
┌────────────────────────────────────────┐
│         Fan-out Service                │
│   Write tweet ID to each follower's    │
│   timeline cache in Redis              │
└────────────────────────────────────────┘
     │
     ├──► Follower 1's timeline cache
     ├──► Follower 2's timeline cache
     └──► ... (up to 10K writes)
```

**Celebrities (> 10K followers): Fan-out on Read**
```
User requests timeline
     │
     ▼
┌────────────────────────────────────────┐
│         Timeline Assembly              │
│   1. Get pre-computed timeline (Redis) │
│   2. Get celebrity tweets on demand    │
│   3. Merge and rank                    │
└────────────────────────────────────────┘
```

### Go Implementation

The following Go implementation demonstrates how the architectural pattern described in this section translates into concrete service code, showing the concurrency primitives, data structures, and interface boundaries that make the design production-viable. This is the level of implementation detail that senior engineers are expected to sketch during a technical interview deep dive.

```go
package timeline

import (
    "context"
    "sort"
    "time"
)

const (
    CelebrityThreshold = 10000
    TimelineSize       = 200
)

type Tweet struct {
    ID        int64
    UserID    int64
    Content   string
    CreatedAt time.Time
}

type TimelineService struct {
    tweetStore    TweetStore
    userGraph     UserGraph
    timelineCache TimelineCache
    fanoutQueue   FanoutQueue
}

// PostTweet handles a new tweet
func (s *TimelineService) PostTweet(ctx context.Context, tweet *Tweet) error {
    // 1. Store the tweet
    if err := s.tweetStore.Store(ctx, tweet); err != nil {
        return err
    }

    // 2. Check if user is celebrity
    followerCount, err := s.userGraph.GetFollowerCount(ctx, tweet.UserID)
    if err != nil {
        return err
    }

    // 3. Fan-out based on follower count
    if followerCount < CelebrityThreshold {
        // Fan-out on write for regular users
        return s.fanoutQueue.Enqueue(ctx, tweet)
    }

    // Celebrities: No fan-out, their tweets are fetched on demand
    return nil
}

// GetTimeline returns the user's timeline
func (s *TimelineService) GetTimeline(ctx context.Context, userID int64) ([]*Tweet, error) {
    // 1. Get pre-computed timeline from cache
    cachedTweetIDs, err := s.timelineCache.GetTimeline(ctx, userID)
    if err != nil {
        return nil, err
    }

    // 2. Get celebrities this user follows
    celebrities, err := s.userGraph.GetFollowedCelebrities(ctx, userID)
    if err != nil {
        return nil, err
    }

    // 3. Get recent tweets from celebrities
    var celebrityTweetIDs []int64
    for _, celeb := range celebrities {
        recent, err := s.tweetStore.GetRecentTweets(ctx, celeb, 10)
        if err != nil {
            continue // Don't fail if one celebrity fetch fails
        }
        celebrityTweetIDs = append(celebrityTweetIDs, recent...)
    }

    // 4. Merge and dedupe
    allTweetIDs := mergeAndDedupe(cachedTweetIDs, celebrityTweetIDs)

    // 5. Fetch full tweets
    tweets, err := s.tweetStore.GetBatch(ctx, allTweetIDs[:min(TimelineSize, len(allTweetIDs))])
    if err != nil {
        return nil, err
    }

    // 6. Sort by time
    sort.Slice(tweets, func(i, j int) bool {
        return tweets[i].CreatedAt.After(tweets[j].CreatedAt)
    })

    return tweets, nil
}

// FanoutWorker processes fan-out queue
func (s *TimelineService) FanoutWorker(ctx context.Context) error {
    for {
        tweet, err := s.fanoutQueue.Dequeue(ctx)
        if err != nil {
            continue
        }

        followers, err := s.userGraph.GetFollowers(ctx, tweet.UserID)
        if err != nil {
            continue
        }

        // Write to each follower's timeline cache
        for _, followerID := range followers {
            s.timelineCache.AddTweet(ctx, followerID, tweet.ID)
        }
    }
}
```


### Junior → FAANG: Understanding Fan-Out Strategies

Fan-out refers to how an event from one source (a user posting a tweet, a payment completing) propagates to multiple consumers or destinations. The two primary patterns are fan-out on write (push model: precompute results and store them for each consumer at write time) and fan-out on read (pull model: compute results at read time by querying the source). Fan-out on write gives fast reads but expensive writes and storage. Fan-out on read gives cheap writes but slower reads. The classic example is a social media feed: if a celebrity with 10M followers posts, fan-out on write means 10M writes immediately. Know when each strategy is appropriate, and know the hybrid approach used by Twitter-style systems (fan-out on write for most users, fan-out on read for celebrity accounts).

### Senior @ FAANG: Fan-Out Strategy as a Platform Architecture Decision

At the senior level, fan-out strategy is an architectural commitment that is expensive to change and affects multiple teams. Choosing fan-out on write means your write path must handle the burst load of your highest-cardinality event, your storage layer must absorb the fanout multiplication, and your consumer teams get a simple read path. Choosing fan-out on read means your read path must be highly available and low-latency, you have a tighter coupling between producers and consumers at query time, and you need careful index design. The bar-raiser question is: what does your fan-out strategy mean for your operational runbook? For fan-out on write, it means handling write surges, backpressure from slow consumers, and re-fan-out when consumers miss events. For fan-out on read, it means read-time aggregation load, cache invalidation strategy, and handling data freshness SLOs. Staff-level concerns include the governance question: who owns the fan-out layer, how is it metered (cost attribution back to producers), and how do you throttle abusive producers without starving legitimate ones.
