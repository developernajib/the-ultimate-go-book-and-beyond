## 69.7 Advanced Hash Table Patterns

### Design Twitter

The Design Twitter problem requires combining user-specific tweet lists with a social graph to produce a merged, time-ordered news feed. Two nested maps (one from user ID to tweet list, another from follower to followee set) provide O(1) follow/unfollow operations, while the news feed is assembled by merging and sorting the tweets of all followed accounts.

```go
// Twitter design with follow, unfollow, post tweet, get news feed
// LeetCode 355: Design Twitter
import "sort"

type Twitter struct {
    tweets     map[int][]Tweet
    following  map[int]map[int]bool
    timestamp  int
}

type Tweet struct {
    id        int
    timestamp int
}

func TwitterConstructor() Twitter {
    return Twitter{
        tweets:    make(map[int][]Tweet),
        following: make(map[int]map[int]bool),
    }
}

func (t *Twitter) PostTweet(userId int, tweetId int) {
    t.timestamp++
    t.tweets[userId] = append(t.tweets[userId], Tweet{tweetId, t.timestamp})
}

func (t *Twitter) GetNewsFeed(userId int) []int {
    // Get all tweets from user and followed users
    allTweets := make([]Tweet, 0)

    // Own tweets
    if tweets, ok := t.tweets[userId]; ok {
        allTweets = append(allTweets, tweets...)
    }

    // Followed users' tweets
    if followed, ok := t.following[userId]; ok {
        for followedId := range followed {
            if tweets, ok := t.tweets[followedId]; ok {
                allTweets = append(allTweets, tweets...)
            }
        }
    }

    // Sort by timestamp (descending)
    sort.Slice(allTweets, func(i, j int) bool {
        return allTweets[i].timestamp > allTweets[j].timestamp
    })

    // Return top 10
    result := make([]int, 0, 10)
    for i := 0; i < len(allTweets) && i < 10; i++ {
        result = append(result, allTweets[i].id)
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
    if t.following[followerId] != nil {
        delete(t.following[followerId], followeeId)
    }
}
```

### Insert Delete GetRandom O(1)

Achieving O(1) random access alongside O(1) insert and delete requires pairing a slice (for index-based random selection) with a map (for O(1) lookup by value). The O(1) delete trick swaps the target element with the last slice element before truncating, then updates the map to reflect the moved element's new index.

```go
// RandomizedSet supports insert, delete, and getRandom in O(1)
// LeetCode 380: Insert Delete GetRandom O(1)
import "math/rand/v2"

type RandomizedSet struct {
    nums    []int
    indices map[int]int // value -> index in nums
}

func RandomizedSetConstructor() RandomizedSet {
    return RandomizedSet{
        nums:    []int{},
        indices: make(map[int]int),
    }
}

func (s *RandomizedSet) Insert(val int) bool {
    if _, ok := s.indices[val]; ok {
        return false
    }

    s.indices[val] = len(s.nums)
    s.nums = append(s.nums, val)
    return true
}

func (s *RandomizedSet) Remove(val int) bool {
    idx, ok := s.indices[val]
    if !ok {
        return false
    }

    // Swap with last element
    lastVal := s.nums[len(s.nums)-1]
    s.nums[idx] = lastVal
    s.indices[lastVal] = idx

    // Remove last element
    s.nums = s.nums[:len(s.nums)-1]
    delete(s.indices, val)

    return true
}

// GetRandom returns a uniformly random element.
// Callers must not call this on an empty set: rand.IntN(0) panics.
func (s *RandomizedSet) GetRandom() int {
    return s.nums[rand.IntN(len(s.nums))]
}
```

### Junior -> FAANG: Composite Data Structure Problems

The two problems in this section (Design Twitter, Insert Delete GetRandom O(1)) are examples of the "design a data structure with these constraints" problem class that appears frequently at Meta and Google. The pattern is always: identify which operations need to be O(1), then ask "which data structure provides O(1) for each required operation?", and then combine structures to cover all operations.

For Design Twitter: the social graph (`map[int]map[int]bool`) provides O(1) follow/unfollow. The tweet list per user provides O(1) append. The slow part is `GetNewsFeed`, which requires merging and sorting. In a real interview, point out this inefficiency and propose the heap-based merge approach as an optimization: use a priority queue seeded with the most recent tweet from each followed user, then pop-and-advance to collect the top 10 in O(K log K) where K is the number of followed users.

For Insert Delete GetRandom O(1): the O(1) delete trick (swap with the last element, then truncate) is the key insight. Without it, deleting from a slice is O(n) because of shifting. The map keeps track of each element's current index, which must be updated when the last element moves to fill the deleted slot. Trace the case where the element being removed *is* the last element, because that is where implementations break: the code writes `indices[lastVal] = idx` before `delete(indices, val)`, and when `lastVal == val` those two lines touch the same key. The delete runs second and wins, so the entry is correctly removed. Swap the order of those statements and you leave a dangling index pointing past the end of the slice.

The reason a slice is required at all is worth stating explicitly: `GetRandom` must sample uniformly in O(1), which needs dense integer indexing into contiguous storage. A Go map cannot do this. Picking a random key from a map means iterating it, which is O(n), and map iteration order, while randomized, is not a uniform sample.

### Senior @ FAANG: Scalable Twitter Feed Design

The Design Twitter problem is a miniature version of a real feed ranking system design question. At the senior interview level, the naive solution (collect all tweets, sort, take top 10) is the starting point, and the interviewer expects you to identify and address its scaling failures.

At 1 billion users each following 1000 accounts, fetching all tweets per GetNewsFeed call is O(1000 * tweet_list_size) per request, which is untenable. The production architecture separates the problem into two paths: a fan-out-on-write path (when a user tweets, push the tweet ID to all followers' feed caches immediately) and a fan-out-on-read path (at read time, merge feeds from a small set of high-cardinality accounts). Twitter historically used fan-out-on-write for most users and fan-out-on-read for celebrity accounts with millions of followers, where the write amplification of pushing to millions of followers is too expensive.

The data structure underlying a production feed cache is typically a sorted list of (timestamp, tweet_id) pairs in a store like Redis, not an in-process map. The map-based implementation here is the correct foundation for understanding the problem, but the staff-level answer acknowledges that the data structure selection (in-process versus distributed) is the primary architectural decision, not the choice of sorting algorithm.
