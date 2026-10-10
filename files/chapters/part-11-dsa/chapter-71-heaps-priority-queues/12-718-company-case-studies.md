## 71.10 Company Case Studies

### Ride-Hailing: Driver Matching with Priority

Matching riders to the best available drivers is a rolling top-K problem, exactly what a heap is for. This is an illustrative design in the shape a dispatch service uses, not a reproduction of any particular company's internals, which are not public.

Read the heap polarity carefully, because it is the whole trick and it reads backwards:

```go
// Driver matching priority queue
package matching

import (
    "container/heap"
    "math"
    "sync"
    "time"
)

type Driver struct {
    ID        string
    Lat, Lng  float64
    Rating    float64
    Status    string
    LastTrip  time.Time
}

type DriverMatch struct {
    Driver   *Driver
    Distance float64
    Score    float64
}

// DriverHeap is a MIN-heap by score.
//
// This looks inverted and is not. We want the k drivers with the HIGHEST
// score, so the heap must surface the weakest current member at the root:
// that is the one to evict when a better driver shows up, and comparing a
// candidate against it is an O(1) rejection test. A max-heap here would put
// the best driver at the root and evict exactly the wrong one.
type DriverHeap []*DriverMatch

func (h DriverHeap) Len() int           { return len(h) }
func (h DriverHeap) Less(i, j int) bool { return h[i].Score < h[j].Score }
func (h DriverHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *DriverHeap) Push(x any) {
    *h = append(*h, x.(*DriverMatch))
}

func (h *DriverHeap) Pop() any {
    old := *h
    n := len(old)
    match := old[n-1]
    old[n-1] = nil // let the driver be collected
    *h = old[0 : n-1]
    return match
}

// DriverMatcher finds best drivers for a rider
type DriverMatcher struct {
    drivers map[string]*Driver
    mu      sync.RWMutex
}

// FindBestDrivers returns the top-k drivers for a ride request,
// best score first. Time: O(n log k), Space: O(k).
func (m *DriverMatcher) FindBestDrivers(riderLat, riderLng float64, k int) []*DriverMatch {
    if k <= 0 {
        return nil
    }

    m.mu.RLock()
    defer m.mu.RUnlock()

    h := &DriverHeap{}
    heap.Init(h)

    for _, driver := range m.drivers {
        if driver.Status != "available" {
            continue
        }

        dist := haversine(riderLat, riderLng, driver.Lat, driver.Lng)
        if dist > 10.0 { // Max 10km
            continue
        }

        score := m.calculateScore(driver, dist)

        if h.Len() < k {
            heap.Push(h, &DriverMatch{Driver: driver, Distance: dist, Score: score})
        } else if score > (*h)[0].Score {
            // Beats the weakest of the current best k, so swap it in.
            heap.Pop(h)
            heap.Push(h, &DriverMatch{Driver: driver, Distance: dist, Score: score})
        }
        // Otherwise the driver cannot make the top k. Rejected in O(1).
    }

    // Popping a min-heap yields ascending score, so fill back to front
    // to hand the caller a best-first slice. h.Len() (not k) sizes the
    // result, since fewer than k drivers may have qualified.
    result := make([]*DriverMatch, h.Len())
    for i := len(result) - 1; i >= 0; i-- {
        result[i] = heap.Pop(h).(*DriverMatch)
    }

    return result
}

func (m *DriverMatcher) calculateScore(driver *Driver, distance float64) float64 {
    distScore := 1.0 / (1.0 + distance)
    ratingScore := driver.Rating / 5.0
    idleBonus := time.Since(driver.LastTrip).Minutes() / 60.0
    return 0.5*distScore + 0.3*ratingScore + 0.2*math.Min(idleBonus, 1.0)
}

func haversine(lat1, lng1, lat2, lng2 float64) float64 {
    const R = 6371 // Earth radius in km
    dLat := (lat2 - lat1) * math.Pi / 180
    dLng := (lng2 - lng1) * math.Pi / 180
    a := math.Sin(dLat/2)*math.Sin(dLat/2) +
        math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
        math.Sin(dLng/2)*math.Sin(dLng/2)
    return 2 * R * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}
```

### Trending Topics

A trending service must rank millions of hashtags in real time without sorting the entire dataset on every request. A fixed-size min-heap of K topics acts as a sliding threshold: the root holds the weakest topic currently in the top-K, so an incoming mention only triggers a replacement when its velocity exceeds that threshold, keeping each update at O(log K) regardless of how many distinct tags exist. Ranking by velocity (mention rate) rather than raw count is what stops evergreen topics with huge historical totals from permanently squatting on the list.

Two details in this version are the ones that matter, and both are places the obvious implementation is silently wrong. First, a topic already in the heap must be repaired with `heap.Fix`, not pushed again, or the same pointer occupies several slots. Second, velocity has to be measured against a real elapsed window.

```go
// Trending topics using a bounded min-heap
package trending

import (
    "container/heap"
    "sort"
    "sync"
    "time"
)

// minWindow floors the age divisor so a tag seen once, one millisecond
// ago, does not divide by ~0 and rocket to the top of the list.
const minWindow = 5 * time.Minute

type Topic struct {
    Tag       string
    Count     int
    Velocity  float64
    FirstSeen time.Time
    UpdatedAt time.Time
    index     int // position in topK, -1 when not in the heap
}

type TopicHeap []*Topic

func (h TopicHeap) Len() int           { return len(h) }
func (h TopicHeap) Less(i, j int) bool { return h[i].Velocity < h[j].Velocity }

// Swap must maintain index, or heap.Fix cannot find an element later.
func (h TopicHeap) Swap(i, j int) {
    h[i], h[j] = h[j], h[i]
    h[i].index = i
    h[j].index = j
}

func (h *TopicHeap) Push(x any) {
    t := x.(*Topic)
    t.index = len(*h)
    *h = append(*h, t)
}

func (h *TopicHeap) Pop() any {
    old := *h
    n := len(old)
    t := old[n-1]
    old[n-1] = nil
    t.index = -1 // mark as no longer resident
    *h = old[0 : n-1]
    return t
}

type TrendingService struct {
    topK   *TopicHeap
    k      int
    counts map[string]*Topic
    mu     sync.Mutex
    now    func() time.Time // injectable for tests
}

func NewTrendingService(k int) *TrendingService {
    h := &TopicHeap{}
    heap.Init(h)
    return &TrendingService{
        topK:   h,
        k:      k,
        counts: make(map[string]*Topic),
        now:    time.Now,
    }
}

func (s *TrendingService) RecordMention(tag string) {
    s.mu.Lock()
    defer s.mu.Unlock()

    now := s.now()
    topic, exists := s.counts[tag]
    if !exists {
        topic = &Topic{Tag: tag, FirstSeen: now, index: -1}
        s.counts[tag] = topic
    }

    topic.Count++
    topic.UpdatedAt = now

    // Rate over the tag's observed lifetime, floored at minWindow.
    // Measuring against FirstSeen (not UpdatedAt) is the point: UpdatedAt
    // was just set to now, so an elapsed time computed from it is always
    // zero and the divisor would clamp to the floor on every single call,
    // making "velocity" nothing but a scaled copy of Count.
    age := now.Sub(topic.FirstSeen)
    if age < minWindow {
        age = minWindow
    }
    topic.Velocity = float64(topic.Count) / age.Hours()

    s.updateTopK(topic)
}

func (s *TrendingService) updateTopK(topic *Topic) {
    // Already resident: its Velocity was mutated in place, so the heap
    // invariant may be broken at exactly one node. Fix repairs it in
    // O(log k). Pushing again would duplicate the pointer.
    if topic.index >= 0 {
        heap.Fix(s.topK, topic.index)
        return
    }

    if s.topK.Len() < s.k {
        heap.Push(s.topK, topic)
        return
    }

    if topic.Velocity > (*s.topK)[0].Velocity {
        heap.Pop(s.topK) // evict the weakest of the top k
        heap.Push(s.topK, topic)
    }
}

// GetTrending returns a sorted snapshot. It copies each Topic by value:
// returning the *Topic pointers would let callers read fields that
// RecordMention concurrently mutates, a data race the lock cannot prevent
// once the pointer escapes.
func (s *TrendingService) GetTrending() []Topic {
    s.mu.Lock()
    defer s.mu.Unlock()

    out := make([]Topic, 0, s.topK.Len())
    for _, t := range *s.topK {
        out = append(out, *t)
    }
    // A heap is not sorted. Only out[0] would be meaningful without this,
    // and it would be the *weakest* topic, not the strongest.
    sort.Slice(out, func(i, j int) bool { return out[i].Velocity > out[j].Velocity })
    return out
}
```

Note that `counts` grows without bound: every tag ever seen stays in the map forever, even one-off typos. That, not the heap, is what actually limits this service, and it is the same lesson as the top-k-by-frequency discussion in the chapter introduction. A real deployment evicts cold tags or fronts the map with a sketch.

### Junior → FAANG: Reading Case Studies as Interview Preparation

The driver matching and trending examples are the real-world framing that interviewers expect when discussing heap applications.

When an interviewer asks "where would you use a heap in production?", these give you concrete answers: "A dispatch service selecting the k best drivers keeps a bounded min-heap of size k ordered by a composite score over distance, rating, and idle time. A trending service keeps a min-heap of size k ordered by velocity, mentions per unit time rather than raw count, so evergreen topics do not crowd out breaking news."

Note that **both** are min-heaps, and both are selecting the *highest*-scoring items. That is not a typo, it is the rule from Section 71.3 showing up twice in production dress. If you find yourself writing a max-heap to collect top-k, stop: you are about to evict your best candidate. This is the single most common way this pattern is written wrong, and it is worth re-deriving rather than recalling. The root must be the item you are willing to throw away.

The scoring function (`0.5*distScore + 0.3*ratingScore + 0.2*idleBonus`) is worth studying because it shows the heap's `Less` can order by an arbitrary composite metric. The heap does not care what the score means, only that it is a total order. Practice expressing such a function explicitly, and note that the weights are a product decision, not an engineering one.

### Senior @ FAANG: Production Concerns Behind the Case Studies

The code above is corrected but still simplified for teaching. Several gaps remain, and identifying them unprompted is the expected staff-level behavior.

**The linear scan is the real problem in driver matching.** `FindBestDrivers` is O(n log k), but the n is every driver in the map, and it holds `RLock` for the whole scan while writers (status changes, location pings) queue behind it. The heap is not the bottleneck and optimizing it would be wasted work. The fix is to stop scanning: index drivers spatially (a grid, geohash, or S2 cell covering) so a request examines only nearby cells, which cuts n by orders of magnitude before the heap ever runs. Location updates then move a driver between cells rather than blocking readers, and you accept slightly stale positions in exchange. Say which consistency model you chose and write it into the service contract.

**Velocity as written is a lifetime average, not a velocity.** The corrected code divides `Count` by age since `FirstSeen`, which is honest and monotone but has no forgetting: a tag that exploded yesterday and is dead today still shows a respectable lifetime rate, and a tag's velocity can only be dragged down slowly by the passage of time. Real trending detection uses a decaying or windowed estimate, an EWMA over mention rate or counts in rolling buckets (say 5-minute buckets over a 1-hour window), so that "trending" means *recently* accelerating. Note also that the original divisor bug (dividing by time since `UpdatedAt`, which was just assigned `now`) is the kind of defect that unit tests miss because every value it produces looks plausible: it silently degenerates velocity into a constant multiple of count, so the ranking still "works" and is simply wrong. Inject the clock, as `now func() time.Time` does here, and you can write a test that advances time and asserts the rate actually falls.

**Window size and decay constant are product decisions.** Validate them against real events with known shapes (breaking news spikes, scheduled sports moments, slow-burn memes) before shipping, because the algorithm cannot tell you what "trending" should mean.

A staff-level review produces this as a written, prioritized list with rough effort per fix, and it leads with the spatial index rather than the heap, because that is where the user-visible latency actually is.

---
