## 83E.9 Problem 7: Twitter Feed (LeetCode 355)

### Requirements

1. Post a tweet
2. Follow/unfollow a user
3. Get the 10 most recent tweets in a user's feed (own + followed users)

### Implementation

The Twitter feed design problem (LeetCode 355) exercises heap-based merge of multiple sorted streams, a pattern that generalizes to feed aggregation, log merging, and time-series querying. The following Go implementation demonstrates a min-heap merge across followed users' tweet streams ordered by timestamp.

```go
package twitter

import "container/heap"

type Tweet struct {
	ID        int
	UserID    int
	Timestamp int
}

type Twitter struct {
	tweets    map[int][]*Tweet   // userID -> their tweets
	following map[int]map[int]bool // userID -> set of followed userIDs
	timestamp int
}

func Constructor() Twitter {
	return Twitter{
		tweets:    make(map[int][]*Tweet),
		following: make(map[int]map[int]bool),
	}
}

func (t *Twitter) PostTweet(userId int, tweetId int) {
	t.timestamp++
	tweet := &Tweet{ID: tweetId, UserID: userId, Timestamp: t.timestamp}
	t.tweets[userId] = append(t.tweets[userId], tweet)
}

func (t *Twitter) GetNewsFeed(userId int) []int {
	// Collect all relevant users
	users := []int{userId}
	if followed, ok := t.following[userId]; ok {
		for uid := range followed {
			users = append(users, uid)
		}
	}

	// Use a max-heap to merge tweets from all users
	h := &tweetHeap{}
	heap.Init(h)

	for _, uid := range users {
		tweets := t.tweets[uid]
		if len(tweets) > 0 {
			// Start from the most recent tweet
			idx := len(tweets) - 1
			heap.Push(h, &heapEntry{
				tweet:    tweets[idx],
				userID:   uid,
				tweetIdx: idx,
			})
		}
	}

	result := make([]int, 0, 10)
	for h.Len() > 0 && len(result) < 10 {
		entry := heap.Pop(h).(*heapEntry)
		result = append(result, entry.tweet.ID)

		// Push the next tweet from this user
		if entry.tweetIdx > 0 {
			nextIdx := entry.tweetIdx - 1
			heap.Push(h, &heapEntry{
				tweet:    t.tweets[entry.userID][nextIdx],
				userID:   entry.userID,
				tweetIdx: nextIdx,
			})
		}
	}

	return result
}

func (t *Twitter) Follow(followerId int, followeeId int) {
	if followerId == followeeId {
		return
	}
	if t.following[followerId] == nil {
		t.following[followerId] = make(map[int]bool)
	}
	t.following[followerId][followeeId] = true
}

func (t *Twitter) Unfollow(followerId int, followeeId int) {
	if followed, ok := t.following[followerId]; ok {
		delete(followed, followeeId)
	}
}

// --- Heap for merging tweets ---

type heapEntry struct {
	tweet    *Tweet
	userID   int
	tweetIdx int
}

type tweetHeap []*heapEntry

func (h tweetHeap) Len() int            { return len(h) }
func (h tweetHeap) Less(i, j int) bool   { return h[i].tweet.Timestamp > h[j].tweet.Timestamp } // max-heap
func (h tweetHeap) Swap(i, j int)        { h[i], h[j] = h[j], h[i] }
func (h *tweetHeap) Push(x interface{})  { *h = append(*h, x.(*heapEntry)) }
func (h *tweetHeap) Pop() interface{} {
	old := *h
	n := len(old)
	x := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return x
}
```

**Complexity:** GetNewsFeed is O(F * log F + 10 * log F) where F is the number of followed users. Post/Follow/Unfollow are O(1).

**Key insight:** This is a k-way merge problem. Use a max-heap initialized with the most recent tweet from each followed user. Pop the top, push the next tweet from that user.


### Junior → FAANG: Twitter Feed LLD Basics

The Twitter feed problem (LeetCode 355) requires designing a simplified Twitter: users can post tweets, follow/unfollow other users, and retrieve the 10 most recent tweets from their timeline. The key insight is that the timeline is a merge of the followed users' tweet lists, sorted by timestamp. The standard implementation maintains a map of user to tweet list and a map of user to follower set. The timeline computation merges the tweet lists using a min-heap (or sorted merge). In Go, model each tweet as a struct with a userID, tweetID, and timestamp.

### Senior @ FAANG: Twitter Feed at the Senior Bar: Fan-Out Strategy and Scalability

At the senior level, the Twitter feed LLD is an entry point for the fan-out on write versus fan-out on read discussion. The LeetCode solution is fan-out on read (compute the timeline at query time by merging followed users' tweets), which is correct for the single-machine problem but does not scale to millions of users and billions of tweets. The production discussion covers: fan-out on write (pre-compute timelines for all followers on tweet post), the celebrity account exception (fan-out on write for an account with 10M followers generates 10M writes per tweet, which is not feasible), and the hybrid approach (fan-out on write for most users, fan-out on read for users following celebrity accounts). Senior candidates should connect the LLD solution to the production architecture and explain where the LLD's design decisions would change at scale.

---
