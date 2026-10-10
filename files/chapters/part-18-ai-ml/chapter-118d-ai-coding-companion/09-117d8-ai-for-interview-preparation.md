## 118D.8 AI for Interview Preparation

### Using AI as a Mock Interviewer

AI is an excellent interview practice partner because it can simulate different interviewer styles, give immediate feedback, and never gets tired of repetition.

**Template: Mock Coding Interview Prompt**

```
Act as a senior Go engineer conducting a coding interview.

Format:
1. Present a problem (medium difficulty, focused on [topic])
2. Let me ask clarifying questions (answer them like a real interviewer)
3. I'll describe my approach. Give feedback before I code
4. I'll write the solution. Review it like an interviewer would
5. Ask me about time/space complexity
6. Ask one follow-up that makes the problem harder
7. After I complete the follow-up, give me a score (1-5) with specific
   feedback on: correctness, code quality, communication, optimization

Important: Don't give me hints unless I'm completely stuck. A real
interviewer would let me struggle a bit.

Topic focus: [data structures / concurrency / system design / algorithms]
```

### Example: Full Mock Coding Interview with AI Feedback

This transcript shows a complete mock interview session: the AI presents a medium-difficulty Go problem, the candidate asks clarifying questions, proposes an approach before coding, and receives feedback on correctness, time complexity, and Go idioms after submitting the solution. Practicing this full loop builds the communication habits that matter as much as the code itself in real interviews.

```
AI: Here's your problem.

PROBLEM: Design and implement a thread-safe in-memory cache in Go
with the following requirements:
- Set(key, value, ttl): store a value with an expiration time
- Get(key): retrieve a value if it exists and hasn't expired
- Delete(key): remove a value
- The cache should automatically clean up expired entries periodically
- It must be safe for concurrent use from multiple goroutines

You have 30 minutes. Start by discussing your approach.

ENGINEER: Let me think about this.

For the data structure, I'll use a map[string]cacheEntry where
cacheEntry holds the value and expiration time. I'll protect it
with a sync.RWMutex, so reads can be concurrent while writes need exclusive
access.

For TTL, I'll store the expiration as a time.Time (time.Now().Add(ttl))
and check it on Get. For cleanup, I'll run a background goroutine
with a ticker that periodically scans for expired entries.

AI: Good start. A few things an interviewer would push on:

1. What type is the value? (This reveals if you think about generics.)
2. How often should the cleanup goroutine run? What's the trade-off?
3. How do you shut down the cleanup goroutine cleanly?

Go ahead and code it.

ENGINEER:
```

```go
package cache

import (
	"context"
	"sync"
	"time"
)

// Cache is a thread-safe in-memory cache with TTL-based expiration.
type Cache[V any] struct {
	mu      sync.RWMutex
	entries map[string]entry[V]
	cancel  context.CancelFunc
}

type entry[V any] struct {
	value     V
	expiresAt time.Time
}

// New creates a cache that cleans up expired entries at the given interval.
// Call Stop() when the cache is no longer needed to release the cleanup goroutine.
func New[V any](cleanupInterval time.Duration) *Cache[V] {
	ctx, cancel := context.WithCancel(context.Background())

	c := &Cache[V]{
		entries: make(map[string]entry[V]),
		cancel:  cancel,
	}

	go c.cleanup(ctx, cleanupInterval)

	return c
}

// Set stores a value with the given TTL. If the key already exists, it is
// overwritten with the new value and TTL.
func (c *Cache[V]) Set(key string, value V, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries[key] = entry[V]{
		value:     value,
		expiresAt: time.Now().Add(ttl),
	}
}

// Get retrieves a value by key. Returns the value and true if found and
// not expired, or the zero value and false otherwise.
func (c *Cache[V]) Get(key string) (V, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	e, exists := c.entries[key]
	if !exists {
		var zero V
		return zero, false
	}

	if time.Now().After(e.expiresAt) {
		var zero V
		return zero, false
	}

	return e.value, true
}

// Delete removes a key from the cache.
func (c *Cache[V]) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

// Len returns the number of entries in the cache, including expired entries
// that have not yet been cleaned up.
func (c *Cache[V]) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}

// Stop terminates the cleanup goroutine. The cache can still be used after
// Stop, but expired entries will not be automatically removed.
func (c *Cache[V]) Stop() {
	c.cancel()
}

func (c *Cache[V]) cleanup(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.removeExpired()
		}
	}
}

func (c *Cache[V]) removeExpired() {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	for key, e := range c.entries {
		if now.After(e.expiresAt) {
			delete(c.entries, key)
		}
	}
}
```

**AI: interviewer feedback.**

```
SCORE: 4/5

STRENGTHS:
- Used generics, which shows modern Go thinking
- RWMutex for read/write separation, good for read-heavy workloads
- Clean shutdown via context cancellation
- Lazy expiration check on Get (don't return expired entries even if
  cleanup hasn't run yet)
- Good documentation comments

AREAS TO IMPROVE:
1. The cleanup goroutine holds the write lock while scanning the
   entire map. At large scale, this could cause latency spikes on
   Get/Set during cleanup. Consider: collect keys to delete under a
   read lock, then delete under a write lock.

2. No size limit. What happens when the cache grows unbounded?
   Consider adding a max-size with LRU eviction.

3. Get returns expired entries as missing but doesn't delete them.
   This is fine (cleanup will handle it), but you could do lazy
   deletion in Get to reduce memory pressure.

FOLLOW-UP QUESTION: How would you modify this cache to support an
LRU eviction policy with a maximum size? What data structure would
you add?
```

### System Design Discussion with AI

**Template: System Design Mock Interview Prompt**

```
Conduct a system design interview with me. The problem is:

"Design [system]"

Rules:
1. Start by asking me what clarifying questions I have
2. Let me drive the design. Don't suggest solutions unless I'm stuck
3. Push me on:
   - Scale estimates (traffic, storage, bandwidth)
   - Data model choices
   - API design
   - High-level architecture
   - Deep-dive into one component
   - Trade-offs and alternatives
4. At the end, score me on:
   - Requirements gathering (did I ask the right questions?)
   - Scale estimation (were my numbers reasonable?)
   - Architecture (was the design sound?)
   - Deep dive (did I show depth in at least one area?)
   - Communication (was I clear and structured?)

Difficulty: [junior/senior/staff level]
Time limit: 45 minutes
```

> **What AI Gets Wrong**: AI mock interviews tend to be too lenient. A real interviewer will pressure-test your assumptions and interrupt you when you're going down a wrong path. Tell AI: "Be a tough interviewer. Push back when my design has holes. Don't let me hand-wave."

> **Pro Tip**: Record your mock interview sessions (talk through your answers out loud, even alone). Communication is 50% of the interview grade at senior levels, and practicing verbal explanation is as important as practicing the technical content.

### Junior → FAANG: AI Mock Interviews as Deliberate Practice Infrastructure

The "be a tough interviewer" instruction in the AI mock interview setup is essential because AI's default mode is too accommodating. A tough mock interviewer pushes back on design choices ("why not use a database directly instead of a cache?"), interrupts when you go down a wrong path ("your approach will have O(n^2) time complexity for this case"), and asks follow-up questions that probe the depth of your understanding ("what happens to your design when the cache server goes down?"). These challenges develop the design defense skills that real FAANG interviewers apply.

The recording practice is the most underutilized interview preparation technique. Communication quality in FAANG interviews is assessed not just on whether you know the content but on how clearly you explain it, how you organize your thoughts under pressure, and how you respond when interrupted. Talking through your answers out loud and listening to the recording reveals communication patterns you cannot notice while thinking: filler words, incomplete sentences, jumping between topics without transitions, and explanations that are clear to you but unclear to a listener.

For Go-specific interview preparation, ask AI to generate coding problems that test Go's specific features: goroutine lifecycle management, channel coordination for fan-out/fan-in, interface satisfaction and embedding, error type hierarchies, and context propagation. These problems appear regularly in FAANG Go engineering interviews and require specific Go knowledge rather than just general algorithms knowledge.

### Senior @ FAANG: Interview Preparation as Career Investment Management

At senior level, the AI interview preparation tools apply to the evaluation side as well as the preparation side. Senior engineers at FAANG are expected to calibrate interview candidates' performance, which requires understanding what excellent, good, and below-bar answers look like for each question. Using AI to generate a range of answer quality levels for a specific interview question ("give me a junior, mid-level, and senior answer to this system design question") helps calibrate interview standards and trains interview judgment.

The "communication is 50% of the interview grade at senior levels" observation is accurate and important for organizational processes. Senior engineers who are strong technical contributors but weak communicators often plateau at L5 because the L6 promotion requires demonstrating the communication capabilities needed to influence without authority (giving technical talks, writing design documents that convince stakeholders, coaching junior engineers). Using AI to practice technical communication specifically (write a design document for this system, then have AI critique it for clarity and persuasiveness) develops the communication skills that technical interview preparation often neglects.

---
