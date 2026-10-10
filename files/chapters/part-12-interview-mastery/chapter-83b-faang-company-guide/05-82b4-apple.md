## 83B.4 Apple

```
┌──────────────────────────────────────────────────────────────────┐
│                    APPLE INTERVIEW PIPELINE                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │  - Role fit, team overview, compensation expectations    │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - Deep technical questions, 1-2 coding problems         │
│       │  - Conversational style, heavy follow-ups                │
│       ▼                                                          │
│  Onsite (5-6 rounds, 45-60 min each)                             │
│       │  - 2-3 Coding rounds (team-specific problems)            │
│       │  - 1 System Design round                                 │
│       │  - 1 Domain Expertise round                              │
│       │  - 1 Hiring Manager round (cultural fit + career)        │
│       ▼                                                          │
│  Debrief                                                         │
│       │  - Team consensus required (all interviewers meet)       │
│       │  - Single "no" can block the hire                        │
│       ▼                                                          │
│  Offer                                                           │
│  Timeline: 4-8 weeks (can extend to 12 - Apple is methodical)    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Company Overview for Go Engineers

Apple is the world's most valuable company, and its engineering culture is unlike any other in tech. While Apple is historically associated with Objective-C, Swift, and C++, Go has established a significant and growing foothold in Apple's backend infrastructure - particularly in services that power iCloud, the App Store, Apple Maps, Apple Music, and the rapidly expanding Apple Intelligence ecosystem. Apple's services revenue exceeded $96 billion in 2025, making backend engineering one of Apple's most critical and fastest-growing areas.

**How Apple Uses Go Internally:**

Go powers a substantial portion of Apple's server-side infrastructure. The language's compilation speed, deployment simplicity, and concurrency model make it ideal for the high-reliability services Apple demands. Apple's internal Go adoption accelerated significantly starting in 2021 as the company shifted more engineering resources toward services and cloud infrastructure.

**Key Products and Teams That Use Go:**

- **iCloud and CloudKit backend** - The data synchronization, storage, and push notification infrastructure that powers iCloud Drive, Photos, Keychain, and cross-device sync for over 2 billion active Apple devices. Go services handle high-throughput event processing, conflict resolution, and distributed state management.
- **App Store backend services** - Search ranking, review processing, app metadata management, and the transaction processing pipeline for billions of annual purchases. Go's performance characteristics make it well-suited for the latency-sensitive search and discovery services.
- **Apple Maps platform** - Tile serving, route calculation microservices, real-time traffic data processing, and points-of-interest services. Go handles the map data pipeline that processes petabytes of geospatial data.
- **Apple Music and media infrastructure** - Content delivery orchestration, recommendation engine components, playlist generation services, and the backend for Apple's growing podcast platform.
- **Apple Intelligence and ML infrastructure** - Model serving infrastructure, feature store services, data preprocessing pipelines, and the orchestration layer for on-device/cloud ML inference splitting. This area is Apple's largest Go growth vector as of 2026.
- **Internal developer tools and CI/CD** - Build system components, automated testing infrastructure, deployment orchestration, and internal API gateways. Apple's internal tooling team is one of the largest Go-first teams.
- **Security and privacy infrastructure** - Certificate management, encryption key rotation services, privacy-preserving analytics pipelines, and the backend for features like App Tracking Transparency.

**Engineering Culture and Values:**

Apple's engineering culture is defined by several distinctive principles that directly affect your interview:

1. **Secrecy and compartmentalization.** Apple famously restricts information on a need-to-know basis. During your interview, you will learn very little about the specific project you would work on. Do not press for details - accept the ambiguity and demonstrate that you can work effectively without full context. Interviewers will notice (and respect) candidates who do not attempt to extract confidential information.

2. **Craftsmanship and attention to detail.** Apple engineers are expected to care deeply about quality at every level - from API design to error messages to performance characteristics. In your interview, writing "good enough" code signals misalignment. Your code should be clean, your variable names meaningful, your edge cases handled, and your API surfaces thoughtful.

3. **Small, empowered teams.** Apple teams are typically 5-12 engineers working on focused problem domains. Each engineer has significant ownership and influence. Interviewers look for candidates who can operate autonomously, make sound technical decisions independently, and communicate effectively with a small group of peers.

4. **Integration thinking.** Apple products work because hardware, software, and services are designed together. Even as a backend Go engineer, you are expected to understand how your service affects the end-user experience. "This reduces sync latency by 200ms" is good. "This reduces sync latency by 200ms, which means a user switching from iPhone to Mac sees their document within 1 second instead of 3" is what Apple wants to hear.

5. **Performance as a feature.** Apple hardware has finite battery, memory, and bandwidth. Backend services that waste resources on the device side are considered defective. Interviewers regularly ask about payload optimization, efficient encoding, and minimizing round trips.

**Interview Process Unique Aspects:**

Apple's interview stands apart from other FAANG companies in three critical ways. First, **the interview is team-specific** - you interview for a specific team, and the questions are tailored to that team's domain. A candidate interviewing for the CloudKit team will face very different questions than one interviewing for Apple Maps. Second, **Apple requires team consensus** - unlike Google's committee model or Amazon's bar raiser, Apple's debrief requires buy-in from all interviewers. A single strong dissent can block the hire. This means you must perform consistently across all rounds. Third, **Apple's hiring manager round is substantive** - it is not a rubber stamp. The hiring manager evaluates cultural alignment, career trajectory, and whether you will thrive in Apple's specific environment. Prepare for this round as seriously as any technical round.

### Interview Process Deep Dive

**Application to Offer: The Complete Pipeline**

**Stage 1: Application or Referral (Week 0)**

Referrals carry significant weight at Apple - more than at most FAANG companies because Apple's teams are small and selective. A referral from someone on the specific team you are targeting is the strongest possible signal. Cold applications through jobs.apple.com are viable but have a lower conversion rate. Apple's job postings are deliberately vague about the specific project (due to secrecy), so target based on team area (e.g., "Server-side engineer, iCloud" or "Backend engineer, Services").

**Stage 2: Recruiter Screen (30 minutes, Week 1-2)**

The Apple recruiter screen covers your experience overview, interest in Apple specifically (not just "I want a FAANG job"), compensation expectations (Apple asks early), and a high-level assessment of technical fit. Apple recruiters are well-trained technically and can filter on specifics. Be prepared to articulate why Apple, why this team area, and what relevant experience you bring. This is not a casual conversation.

**Stage 3: Technical Phone Screen (60 minutes, Week 2-4)**

Apple's phone screen is longer than most (60 minutes vs. 45 at Google and Meta). It typically includes 1-2 coding problems in a shared editor, but the format is more conversational than at other companies. The interviewer will ask deep follow-up questions about your solution: "Why did you choose this data structure?", "How would this behave with 10 million entries?", "What happens if this runs concurrently?" Expect the interviewer to challenge your decisions and probe for true understanding rather than memorized solutions.

The phone screen interviewer is typically a senior engineer (ICT4 or ICT5) from the hiring team. Their feedback carries more weight than phone screeners at companies where screeners are drawn from a general pool.

**Stage 4: Onsite Interview (5-6 rounds, 45-60 minutes each, Week 3-6)**

The onsite consists of:
- **2-3 Coding rounds:** Team-specific problems with deep follow-ups. Expect problems that reflect the team's actual domain. A storage team will ask about data structures for efficient retrieval. A networking team will ask about protocol design. Problems tend to be medium-to-hard difficulty with emphasis on clean code and deep discussion.
- **1 System Design round:** Performance-focused design. Apple interviewers care about efficiency, reliability, and user-perceived latency more than raw scale. "Design a photo sync service" is more likely than "Design Twitter."
- **1 Domain Expertise round:** Deep technical discussion about your past work and relevant domain knowledge. This round has no coding - it is a technical conversation where the interviewer assesses whether you have genuine expertise or surface-level familiarity.
- **1 Hiring Manager round:** Cultural fit, career goals, teamwork, and working style. The hiring manager assesses whether you will thrive on their specific team. This is also where Apple's secrecy culture is evaluated - candidates who demonstrate discretion and professionalism score higher.

**Who interviews you:** Your interviewers are members of the actual team you would join (ICT3-ICT5 for coding, ICT5+ for design, hiring manager for the HM round). This is different from Google (where interviewers come from any team) and means interviewers evaluate both general engineering skill and domain fit simultaneously.

**Stage 5: Debrief (Week 4-7)**

All interviewers meet to discuss your candidacy. Each provides a rating and written feedback. Apple uses a consensus model - a single strong "no" can block the hire, even if all other interviewers say yes. This makes consistency across rounds critical. A "strong yes" in coding but "no" in cultural fit means no offer.

**Stage 6: Offer (Week 5-8)**

Apple's offers are competitive but structured differently from other FAANG companies. Base salary is high, RSU grants vest over 4 years (with a back-loaded vesting schedule historically, though this has shifted closer to even vesting for competitive candidates), and signing bonuses are common for senior hires. Apple also provides substantial employee discounts and other benefits.

**Timeline: 4-8 weeks typical, but can extend to 12 weeks.** Apple is methodical and does not rush decisions. Do not interpret silence as rejection - Apple's process is genuinely slower than Meta's or Microsoft's.

### Level Expectations

**ICT2 (Software Engineer - New Grad / 0-2 years):**
- Solve medium coding problems cleanly with good variable naming and edge case handling
- Basic system design: design a key-value store, design a simple sync protocol
- Demonstrate genuine curiosity about how systems work at a low level
- Show ability to work independently within a well-defined scope
- Approximate total compensation (2025-2026): $180,000-$240,000

**ICT3 (Software Engineer - 2-5 years):**
- Solve medium-hard coding problems with deep discussion of trade-offs and alternatives
- Moderate system design: design a notification delivery system, design a media processing pipeline
- Show ownership of a feature or component with measurable impact
- Demonstrate ability to collaborate within a small team and contribute to technical discussions
- Approximate total compensation (2025-2026): $250,000-$380,000

**ICT4 (Senior Software Engineer - 5-10 years):**
- Solve hard coding problems, discuss multiple approaches, and articulate why one is better for the specific context
- Advanced system design: design a cross-device sync service, design a real-time location pipeline at scale
- Architecture decisions with measurable user-facing impact: "Redesigned the sync protocol, reducing conflict rates by 85% and improving perceived responsiveness"
- Technical leadership within the team: mentoring, code review standards, technical documentation
- Approximate total compensation (2025-2026): $400,000-$600,000

**ICT5 (Staff Software Engineer - 8-15+ years):**
- System design mastery: design Apple-scale services with deep understanding of performance, reliability, and privacy
- Cross-team influence: set technical direction that affects multiple teams or products
- Architecture vision: defined the technical strategy for a product area or platform component
- Strategic thinking: connected technical decisions to user experience and business outcomes
- Approximate total compensation (2025-2026): $600,000-$900,000+

**ICT6 (Principal Engineer - 15+ years, rare):**
- Organization-level technical direction and architecture decisions
- Influence on Apple-wide engineering standards and practices
- Typically reports to VP-level leadership
- Approximate total compensation (2025-2026): $900,000-$1,400,000+

### Top 20 Apple Go Interview Questions with Solutions

#### Question 1: Design a Thread-Safe Ring Buffer (Easy-Medium)

*Apple loves systems-level questions that test understanding of concurrent data structures. Ring buffers are fundamental to media pipelines and I/O subsystems - both core Apple domains.*

**Key Insight:** Use sync.Cond for blocking producer-consumer coordination. The ring buffer avoids allocations in the hot path by pre-allocating the backing array.

```go
package main

import (
	"fmt"
	"sync"
)

// RingBuffer is a fixed-size, thread-safe circular buffer.
type RingBuffer[T any] struct {
	mu       sync.Mutex
	buf      []T
	size     int
	read     int
	write    int
	count    int
	notEmpty *sync.Cond
	notFull  *sync.Cond
}

func NewRingBuffer[T any](size int) *RingBuffer[T] {
	rb := &RingBuffer[T]{
		buf:  make([]T, size),
		size: size,
	}
	rb.notEmpty = sync.NewCond(&rb.mu)
	rb.notFull = sync.NewCond(&rb.mu)
	return rb
}

// Write blocks until space is available, then writes the value.
func (rb *RingBuffer[T]) Write(val T) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	for rb.count == rb.size {
		rb.notFull.Wait()
	}

	rb.buf[rb.write] = val
	rb.write = (rb.write + 1) % rb.size
	rb.count++
	rb.notEmpty.Signal()
}

// Read blocks until data is available, then returns the oldest value.
func (rb *RingBuffer[T]) Read() T {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	for rb.count == 0 {
		rb.notEmpty.Wait()
	}

	val := rb.buf[rb.read]
	rb.read = (rb.read + 1) % rb.size
	rb.count--
	rb.notFull.Signal()
	return val
}

// TryWrite attempts a non-blocking write. Returns false if full.
func (rb *RingBuffer[T]) TryWrite(val T) bool {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	if rb.count == rb.size {
		return false
	}

	rb.buf[rb.write] = val
	rb.write = (rb.write + 1) % rb.size
	rb.count++
	rb.notEmpty.Signal()
	return true
}

// TryRead attempts a non-blocking read. Returns zero value and false if empty.
func (rb *RingBuffer[T]) TryRead() (T, bool) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	var zero T
	if rb.count == 0 {
		return zero, false
	}

	val := rb.buf[rb.read]
	rb.read = (rb.read + 1) % rb.size
	rb.count--
	rb.notFull.Signal()
	return val, true
}

func (rb *RingBuffer[T]) Len() int {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	return rb.count
}

func main() {
	rb := NewRingBuffer[int](5)

	var wg sync.WaitGroup
	wg.Add(2)

	// Producer
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			rb.Write(i)
			fmt.Printf("Wrote: %d\n", i)
		}
	}()

	// Consumer
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			val := rb.Read()
			fmt.Printf("Read: %d\n", val)
		}
	}()

	wg.Wait()
}
```

**Time Complexity:** O(1) for all operations. **Space Complexity:** O(n) where n is buffer capacity.

**Apple follow-up questions:** "How would you add a Close method for graceful shutdown?", "What happens if multiple producers and consumers are racing?", "How would you instrument this for monitoring buffer pressure?"

#### Question 2: Implement a Bloom Filter (Medium)

*Bloom filters appear in Apple's storage infrastructure for membership testing - checking if a key exists before hitting disk. Apple values understanding of probabilistic data structures.*

**Key Insight:** Optimal size and hash count are derived from the expected number of items and desired false positive rate. Double hashing avoids the need for multiple independent hash functions.

```go
package main

import (
	"fmt"
	"hash"
	"hash/fnv"
	"math"
)

// BloomFilter is a space-efficient probabilistic data structure.
type BloomFilter struct {
	bits    []bool
	size    uint
	hashFns int
}

func NewBloomFilter(expectedItems int, falsePositiveRate float64) *BloomFilter {
	size := optimalSize(expectedItems, falsePositiveRate)
	hashFns := optimalHashCount(size, expectedItems)
	return &BloomFilter{
		bits:    make([]bool, size),
		size:    size,
		hashFns: hashFns,
	}
}

func optimalSize(n int, p float64) uint {
	m := -float64(n) * math.Log(p) / (math.Log(2) * math.Log(2))
	return uint(math.Ceil(m))
}

func optimalHashCount(m uint, n int) int {
	k := float64(m) / float64(n) * math.Log(2)
	return int(math.Ceil(k))
}

func (bf *BloomFilter) Add(item []byte) {
	for i := 0; i < bf.hashFns; i++ {
		idx := bf.hash(item, i) % bf.size
		bf.bits[idx] = true
	}
}

func (bf *BloomFilter) MayContain(item []byte) bool {
	for i := 0; i < bf.hashFns; i++ {
		idx := bf.hash(item, i) % bf.size
		if !bf.bits[idx] {
			return false
		}
	}
	return true
}

func (bf *BloomFilter) hash(item []byte, seed int) uint {
	var h hash.Hash32 = fnv.New32a()
	h.Write(item)
	h.Write([]byte{byte(seed)})
	return uint(h.Sum32())
}

// FalsePositiveRate returns the estimated current false positive rate.
func (bf *BloomFilter) FalsePositiveRate(insertedCount int) float64 {
	exponent := -float64(bf.hashFns) * float64(insertedCount) / float64(bf.size)
	return math.Pow(1-math.Exp(exponent), float64(bf.hashFns))
}

func main() {
	bf := NewBloomFilter(1000, 0.01)
	bf.Add([]byte("apple"))
	bf.Add([]byte("banana"))

	fmt.Println(bf.MayContain([]byte("apple")))  // true
	fmt.Println(bf.MayContain([]byte("banana"))) // true
	fmt.Println(bf.MayContain([]byte("cherry"))) // false (probably)
	fmt.Printf("Estimated FP rate after 2 inserts: %.6f\n", bf.FalsePositiveRate(2))
}
```

**Time Complexity:** O(k) per operation where k is the number of hash functions. **Space Complexity:** O(m) where m is the optimal bit array size.

#### Question 3: Serialize Data with Variable-Length Encoding (Medium)

*Apple's protocols use compact binary formats for efficiency. Protobuf-style varint encoding is a practical skill Apple tests.*

**Key Insight:** Variable-length encoding uses the high bit of each byte as a continuation flag. This saves space for small numbers (common in real data) at the cost of extra bytes for very large numbers.

```go
package main

import (
	"encoding/binary"
	"fmt"
)

// EncodeVarint encodes an integer using variable-length encoding.
func EncodeVarint(n uint64) []byte {
	buf := make([]byte, 0, 10)
	for n >= 0x80 {
		buf = append(buf, byte(n)|0x80)
		n >>= 7
	}
	buf = append(buf, byte(n))
	return buf
}

// DecodeVarint decodes a variable-length encoded integer.
// Returns the decoded value and number of bytes consumed.
func DecodeVarint(buf []byte) (uint64, int) {
	var result uint64
	var shift uint
	for i, b := range buf {
		if i >= 10 {
			return 0, 0 // varint too long - malformed
		}
		result |= uint64(b&0x7F) << shift
		if b < 0x80 {
			return result, i + 1
		}
		shift += 7
	}
	return 0, 0
}

// EncodeStrings encodes a list of strings with length-prefix framing.
func EncodeStrings(strs []string) []byte {
	var buf []byte
	countBytes := make([]byte, 4)
	binary.BigEndian.PutUint32(countBytes, uint32(len(strs)))
	buf = append(buf, countBytes...)

	for _, s := range strs {
		lenBytes := EncodeVarint(uint64(len(s)))
		buf = append(buf, lenBytes...)
		buf = append(buf, []byte(s)...)
	}
	return buf
}

// DecodeStrings decodes a list of strings from the encoded format.
func DecodeStrings(buf []byte) []string {
	count := binary.BigEndian.Uint32(buf[:4])
	offset := 4
	result := make([]string, 0, count)

	for i := uint32(0); i < count; i++ {
		strLen, n := DecodeVarint(buf[offset:])
		offset += n
		result = append(result, string(buf[offset:offset+int(strLen)]))
		offset += int(strLen)
	}
	return result
}

func main() {
	strs := []string{"hello", "world", "go", "apple"}
	encoded := EncodeStrings(strs)
	fmt.Printf("Encoded %d bytes\n", len(encoded))

	decoded := DecodeStrings(encoded)
	fmt.Println(decoded)

	for _, n := range []uint64{1, 127, 128, 300, 100000} {
		enc := EncodeVarint(n)
		dec, _ := DecodeVarint(enc)
		fmt.Printf("%d -> %d bytes -> %d\n", n, len(enc), dec)
	}
}
```

**Time Complexity:** O(n) for encoding/decoding n strings. **Space Complexity:** O(total string bytes) for the encoded output.

#### Question 4: Flatten Nested List Iterator with Lazy Evaluation (Medium)

*Apple interviews frequently test iterator patterns. This tests your understanding of lazy evaluation and stack-based state management.*

**Key Insight:** Use an explicit stack to track position within nested lists. HasNext advances the stack until it points at an integer, and Next consumes it. This avoids flattening the entire structure upfront.

```go
package main

import "fmt"

type NestedInt struct {
	isInt bool
	val   int
	list  []*NestedInt
}

type LazyIterator struct {
	stack [][]*NestedInt
	idxs  []int
}

func NewLazyIterator(list []*NestedInt) *LazyIterator {
	return &LazyIterator{
		stack: [][]*NestedInt{list},
		idxs:  []int{0},
	}
}

func (it *LazyIterator) HasNext() bool {
	for len(it.stack) > 0 {
		depth := len(it.stack) - 1
		list := it.stack[depth]
		idx := it.idxs[depth]

		if idx >= len(list) {
			it.stack = it.stack[:depth]
			it.idxs = it.idxs[:depth]
			continue
		}

		if list[idx].isInt {
			return true
		}

		it.idxs[depth]++
		it.stack = append(it.stack, list[idx].list)
		it.idxs = append(it.idxs, 0)
	}
	return false
}

func (it *LazyIterator) Next() int {
	depth := len(it.stack) - 1
	val := it.stack[depth][it.idxs[depth]].val
	it.idxs[depth]++
	return val
}

func main() {
	// Represents [[1,1],2,[1,1]]
	list := []*NestedInt{
		{list: []*NestedInt{{isInt: true, val: 1}, {isInt: true, val: 1}}},
		{isInt: true, val: 2},
		{list: []*NestedInt{{isInt: true, val: 1}, {isInt: true, val: 1}}},
	}

	it := NewLazyIterator(list)
	for it.HasNext() {
		fmt.Printf("%d ", it.Next())
	}
	// Output: 1 1 2 1 1
}
```

**Time Complexity:** O(1) amortized per Next call. **Space Complexity:** O(d) where d is maximum nesting depth.

#### Question 5: Design a Memory Allocator (Medium - Apple-Specific)

*Apple cares deeply about memory management. This problem tests understanding of contiguous allocation, fragmentation, and efficient free-list management.*

**Key Insight:** First-fit allocation with a free-list. The allocator tracks contiguous free blocks and splits or merges them as needed.

```go
package main

import "fmt"

// MemoryAllocator manages a contiguous block of memory using first-fit allocation.
type MemoryAllocator struct {
	memory []int // 0 = free, >0 = allocated with mID
	size   int
}

func NewMemoryAllocator(n int) *MemoryAllocator {
	return &MemoryAllocator{memory: make([]int, n), size: n}
}

// Allocate finds the first contiguous block of the given size and assigns it to mID.
// Returns the starting index, or -1 if allocation fails.
func (a *MemoryAllocator) Allocate(size, mID int) int {
	count := 0
	for i := 0; i < a.size; i++ {
		if a.memory[i] == 0 {
			count++
			if count == size {
				start := i - size + 1
				for j := start; j <= i; j++ {
					a.memory[j] = mID
				}
				return start
			}
		} else {
			count = 0
		}
	}
	return -1
}

// Free releases all blocks allocated to the given mID.
// Returns the number of bytes freed.
func (a *MemoryAllocator) Free(mID int) int {
	freed := 0
	for i := 0; i < a.size; i++ {
		if a.memory[i] == mID {
			a.memory[i] = 0
			freed++
		}
	}
	return freed
}

// Fragmentation returns the number of free blocks that are not contiguous
// with another free block - a measure of external fragmentation.
func (a *MemoryAllocator) Fragmentation() int {
	fragments := 0
	inFree := false
	for i := 0; i < a.size; i++ {
		if a.memory[i] == 0 && !inFree {
			fragments++
			inFree = true
		} else if a.memory[i] != 0 {
			inFree = false
		}
	}
	return fragments
}

func main() {
	alloc := NewMemoryAllocator(20)
	fmt.Println(alloc.Allocate(5, 1))  // 0
	fmt.Println(alloc.Allocate(3, 2))  // 5
	fmt.Println(alloc.Allocate(4, 3))  // 8
	fmt.Println(alloc.Free(2))         // 3
	fmt.Println(alloc.Allocate(2, 4))  // 5 (reuses freed space)
	fmt.Printf("Fragmentation: %d free regions\n", alloc.Fragmentation())
}
```

**Time Complexity:** O(n) for Allocate and Free. **Space Complexity:** O(n) for the memory array.

#### Question 6: LRU Cache with TTL Expiration (Medium - Apple-Specific)

*Apple's caching layers need both LRU eviction and time-based expiration. This combines two classic problems.*

**Key Insight:** Extend the standard LRU cache with per-entry expiration timestamps. On Get, check if the entry is expired before returning. Use lazy cleanup on access plus periodic background sweeps.

```go
package main

import (
	"container/list"
	"fmt"
	"sync"
	"time"
)

type ttlEntry struct {
	key       string
	value     any
	expiresAt time.Time
}

// TTLLRUCache combines LRU eviction with per-entry TTL expiration.
type TTLLRUCache struct {
	mu       sync.Mutex
	capacity int
	items    map[string]*list.Element
	order    *list.List
}

func NewTTLLRUCache(capacity int) *TTLLRUCache {
	return &TTLLRUCache{
		capacity: capacity,
		items:    make(map[string]*list.Element, capacity),
		order:    list.New(),
	}
}

func (c *TTLLRUCache) Get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[key]
	if !ok {
		return nil, false
	}

	entry := elem.Value.(*ttlEntry)
	if time.Now().After(entry.expiresAt) {
		c.removeElement(elem)
		return nil, false
	}

	c.order.MoveToFront(elem)
	return entry.value, true
}

func (c *TTLLRUCache) Put(key string, value any, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		entry := elem.Value.(*ttlEntry)
		entry.value = value
		entry.expiresAt = time.Now().Add(ttl)
		c.order.MoveToFront(elem)
		return
	}

	if c.order.Len() >= c.capacity {
		c.evictOldest()
	}

	entry := &ttlEntry{key: key, value: value, expiresAt: time.Now().Add(ttl)}
	elem := c.order.PushFront(entry)
	c.items[key] = elem
}

func (c *TTLLRUCache) evictOldest() {
	oldest := c.order.Back()
	if oldest != nil {
		c.removeElement(oldest)
	}
}

func (c *TTLLRUCache) removeElement(elem *list.Element) {
	c.order.Remove(elem)
	entry := elem.Value.(*ttlEntry)
	delete(c.items, entry.key)
}

// CleanExpired removes all expired entries. Call periodically from a background goroutine.
func (c *TTLLRUCache) CleanExpired() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	cleaned := 0
	for e := c.order.Back(); e != nil; {
		prev := e.Prev()
		entry := e.Value.(*ttlEntry)
		if now.After(entry.expiresAt) {
			c.removeElement(e)
			cleaned++
		}
		e = prev
	}
	return cleaned
}

func main() {
	cache := NewTTLLRUCache(3)
	cache.Put("a", "value-a", 2*time.Second)
	cache.Put("b", "value-b", 5*time.Second)
	cache.Put("c", "value-c", 10*time.Second)

	if v, ok := cache.Get("a"); ok {
		fmt.Println("a:", v)
	}

	time.Sleep(3 * time.Second)

	if _, ok := cache.Get("a"); !ok {
		fmt.Println("a: expired")
	}
	if v, ok := cache.Get("b"); ok {
		fmt.Println("b:", v)
	}
}
```

**Time Complexity:** O(1) for Get and Put. O(n) for CleanExpired. **Space Complexity:** O(capacity).

#### Question 7: Find Peak Element Using Binary Search (Easy)

*Apple tests binary search rigorously. This seemingly simple problem has subtle correctness pitfalls.*

**Key Insight:** Compare mid with mid+1. If nums[mid] > nums[mid+1], the peak is in the left half (including mid). Otherwise, it is in the right half. This works because the boundaries are negative infinity.

```go
package main

import "fmt"

func findPeakElement(nums []int) int {
	lo, hi := 0, len(nums)-1
	for lo < hi {
		mid := lo + (hi-lo)/2
		if nums[mid] > nums[mid+1] {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return lo
}

func main() {
	fmt.Println(findPeakElement([]int{1, 2, 3, 1}))       // 2
	fmt.Println(findPeakElement([]int{1, 2, 1, 3, 5, 6, 4})) // 5 (or 1)
	fmt.Println(findPeakElement([]int{1}))                 // 0
	fmt.Println(findPeakElement([]int{2, 1}))              // 0
}
```

**Time Complexity:** O(log n). **Space Complexity:** O(1).

#### Question 8: Merge Intervals (Easy-Medium)

*A staple at Apple, often followed by questions about interval scheduling for resource management.*

**Key Insight:** Sort by start time, then greedily merge overlapping intervals.

```go
package main

import (
	"fmt"
	"sort"
)

func mergeIntervals(intervals [][]int) [][]int {
	if len(intervals) <= 1 {
		return intervals
	}

	sort.Slice(intervals, func(i, j int) bool {
		return intervals[i][0] < intervals[j][0]
	})

	merged := [][]int{intervals[0]}
	for i := 1; i < len(intervals); i++ {
		last := merged[len(merged)-1]
		if intervals[i][0] <= last[1] {
			if intervals[i][1] > last[1] {
				last[1] = intervals[i][1]
			}
		} else {
			merged = append(merged, intervals[i])
		}
	}
	return merged
}

func main() {
	intervals := [][]int{{1, 3}, {2, 6}, {8, 10}, {15, 18}}
	fmt.Println(mergeIntervals(intervals)) // [[1,6],[8,10],[15,18]]
}
```

**Time Complexity:** O(n log n) for sorting. **Space Complexity:** O(n) for the result.

#### Question 9: Implement KMP String Matching (Medium)

*Apple tests string algorithms with emphasis on efficiency. The KMP algorithm avoids redundant comparisons using a failure function.*

**Key Insight:** The failure function preprocesses the pattern to determine how far back to fall when a mismatch occurs, avoiding re-scanning characters in the haystack.

```go
package main

import "fmt"

func strStr(haystack, needle string) int {
	if len(needle) == 0 {
		return 0
	}

	// Build failure function (partial match table)
	fail := make([]int, len(needle))
	for i, j := 1, 0; i < len(needle); {
		if needle[i] == needle[j] {
			j++
			fail[i] = j
			i++
		} else if j > 0 {
			j = fail[j-1]
		} else {
			fail[i] = 0
			i++
		}
	}

	// Search using the failure function
	j := 0
	for i := 0; i < len(haystack); {
		if haystack[i] == needle[j] {
			i++
			j++
			if j == len(needle) {
				return i - j
			}
		} else if j > 0 {
			j = fail[j-1]
		} else {
			i++
		}
	}
	return -1
}

func main() {
	fmt.Println(strStr("hello", "ll"))          // 2
	fmt.Println(strStr("aaaaa", "bba"))         // -1
	fmt.Println(strStr("aabaaabaaac", "aabaaac")) // 4
}
```

**Time Complexity:** O(n + m) where n is haystack length and m is needle length. **Space Complexity:** O(m) for the failure function.

#### Question 10: Longest Substring Without Repeating Characters (Easy-Medium)

*Classic sliding window problem. Apple tests this with follow-ups about Unicode handling and streaming data.*

**Key Insight:** Maintain a sliding window using a map to track the last seen position of each character. When a repeat is found, jump the window start forward.

```go
package main

import "fmt"

func lengthOfLongestSubstring(s string) int {
	lastSeen := make(map[byte]int)
	maxLen, start := 0, 0

	for i := 0; i < len(s); i++ {
		if last, ok := lastSeen[s[i]]; ok && last >= start {
			start = last + 1
		}
		if i-start+1 > maxLen {
			maxLen = i - start + 1
		}
		lastSeen[s[i]] = i
	}
	return maxLen
}

func main() {
	fmt.Println(lengthOfLongestSubstring("abcabcbb")) // 3
	fmt.Println(lengthOfLongestSubstring("bbbbb"))    // 1
	fmt.Println(lengthOfLongestSubstring("pwwkew"))   // 3
	fmt.Println(lengthOfLongestSubstring(""))          // 0
}
```

**Time Complexity:** O(n). **Space Complexity:** O(min(n, alphabet_size)).

#### Question 11: Design a Hit Counter with Sliding Window (Easy-Medium)

*Practical systems problem. Apple uses these patterns for analytics, rate limiting, and monitoring.*

**Key Insight:** Use a circular buffer of fixed size (300 for a 5-minute window). Each slot stores the timestamp and hit count. When a new hit arrives at a slot whose timestamp has rolled over, reset the count.

```go
package main

import "fmt"

// HitCounter tracks hits over a 300-second sliding window.
type HitCounter struct {
	hits  []int
	times []int
}

func NewHitCounter() *HitCounter {
	return &HitCounter{
		hits:  make([]int, 300),
		times: make([]int, 300),
	}
}

func (hc *HitCounter) Hit(timestamp int) {
	idx := timestamp % 300
	if hc.times[idx] != timestamp {
		hc.times[idx] = timestamp
		hc.hits[idx] = 1
	} else {
		hc.hits[idx]++
	}
}

func (hc *HitCounter) GetHits(timestamp int) int {
	total := 0
	for i := 0; i < 300; i++ {
		if timestamp-hc.times[i] < 300 {
			total += hc.hits[i]
		}
	}
	return total
}

func main() {
	hc := NewHitCounter()
	hc.Hit(1)
	hc.Hit(2)
	hc.Hit(3)
	fmt.Println(hc.GetHits(4))   // 3
	hc.Hit(300)
	fmt.Println(hc.GetHits(300)) // 4
	fmt.Println(hc.GetHits(301)) // 3 (hit at timestamp 1 has expired)
}
```

**Time Complexity:** O(1) for Hit, O(300) = O(1) for GetHits. **Space Complexity:** O(1) - fixed 300-slot buffer.

#### Question 12: Valid Sudoku (Easy-Medium)

*Apple tests attention to detail with constraint-checking problems. The follow-up is often "now solve it."*

**Key Insight:** Use three 9x9 boolean arrays to track seen digits in each row, column, and 3x3 box. A single pass is sufficient.

```go
package main

import "fmt"

func isValidSudoku(board [][]byte) bool {
	var rows, cols, boxes [9][9]bool

	for r := 0; r < 9; r++ {
		for c := 0; c < 9; c++ {
			if board[r][c] == '.' {
				continue
			}
			num := board[r][c] - '1'
			box := (r/3)*3 + c/3
			if rows[r][num] || cols[c][num] || boxes[box][num] {
				return false
			}
			rows[r][num] = true
			cols[c][num] = true
			boxes[box][num] = true
		}
	}
	return true
}

func main() {
	board := [][]byte{
		{'5', '3', '.', '.', '7', '.', '.', '.', '.'},
		{'6', '.', '.', '1', '9', '5', '.', '.', '.'},
		{'.', '9', '8', '.', '.', '.', '.', '6', '.'},
		{'8', '.', '.', '.', '6', '.', '.', '.', '3'},
		{'4', '.', '.', '8', '.', '3', '.', '.', '1'},
		{'7', '.', '.', '.', '2', '.', '.', '.', '6'},
		{'.', '6', '.', '.', '.', '.', '2', '8', '.'},
		{'.', '.', '.', '4', '1', '9', '.', '.', '5'},
		{'.', '.', '.', '.', '8', '.', '.', '7', '9'},
	}
	fmt.Println(isValidSudoku(board)) // true
}
```

**Time Complexity:** O(1) - the board is always 9x9. **Space Complexity:** O(1) - fixed-size arrays.

#### Question 13: Zigzag Level Order Traversal (Medium)

*Tree traversals with variations are common at Apple. This tests BFS with an alternating direction twist.*

**Key Insight:** Standard BFS with a flag that toggles direction each level. When right-to-left, reverse the placement index within the level array.

```go
package main

import "fmt"

type TreeNode struct {
	Val   int
	Left  *TreeNode
	Right *TreeNode
}

func zigzagLevelOrder(root *TreeNode) [][]int {
	if root == nil {
		return nil
	}
	var result [][]int
	queue := []*TreeNode{root}
	leftToRight := true

	for len(queue) > 0 {
		size := len(queue)
		level := make([]int, size)
		for i := 0; i < size; i++ {
			node := queue[i]
			idx := i
			if !leftToRight {
				idx = size - 1 - i
			}
			level[idx] = node.Val
			if node.Left != nil {
				queue = append(queue, node.Left)
			}
			if node.Right != nil {
				queue = append(queue, node.Right)
			}
		}
		queue = queue[size:]
		result = append(result, level)
		leftToRight = !leftToRight
	}
	return result
}

func main() {
	root := &TreeNode{3,
		&TreeNode{9, nil, nil},
		&TreeNode{20, &TreeNode{15, nil, nil}, &TreeNode{7, nil, nil}},
	}
	fmt.Println(zigzagLevelOrder(root)) // [[3],[20,9],[15,7]]
}
```

**Time Complexity:** O(n) visiting every node once. **Space Complexity:** O(w) where w is the maximum level width.

#### Question 14: Reverse Linked List in Groups of K (Hard)

*Apple tests linked list manipulation for systems work (buffer chains, packet processing). The recursive approach is elegant but the iterative follow-up is expected.*

**Key Insight:** Recursively process each group of k nodes. Check that k nodes remain before reversing. The recursive call handles the rest of the list.

```go
package main

import "fmt"

type ListNode struct {
	Val  int
	Next *ListNode
}

func reverseKGroup(head *ListNode, k int) *ListNode {
	// Check if we have k nodes
	count := 0
	curr := head
	for curr != nil && count < k {
		curr = curr.Next
		count++
	}
	if count < k {
		return head
	}

	// Reverse the first k nodes
	prev := reverseKGroup(curr, k)
	curr = head
	for i := 0; i < k; i++ {
		next := curr.Next
		curr.Next = prev
		prev = curr
		curr = next
	}
	return prev
}

func printList(head *ListNode) {
	for head != nil {
		fmt.Printf("%d ", head.Val)
		head = head.Next
	}
	fmt.Println()
}

func main() {
	// Build: 1->2->3->4->5
	head := &ListNode{1, &ListNode{2, &ListNode{3, &ListNode{4, &ListNode{5, nil}}}}}
	result := reverseKGroup(head, 2)
	printList(result) // 2 1 4 3 5
}
```

**Time Complexity:** O(n). **Space Complexity:** O(n/k) for recursive stack. O(1) for iterative version.

#### Question 15: Decode String with Nested Brackets (Medium)

*Tests stack-based parsing. Apple asks this in the context of protocol parsing or configuration processing.*

**Key Insight:** Use two stacks - one for repeat counts, one for accumulated strings. On `[`, push the current state. On `]`, pop and repeat.

```go
package main

import (
	"fmt"
	"strings"
)

func decodeString(s string) string {
	var stack []string
	var countStack []int
	current := ""
	k := 0

	for _, ch := range s {
		switch {
		case ch >= '0' && ch <= '9':
			k = k*10 + int(ch-'0')
		case ch == '[':
			countStack = append(countStack, k)
			stack = append(stack, current)
			current = ""
			k = 0
		case ch == ']':
			count := countStack[len(countStack)-1]
			countStack = countStack[:len(countStack)-1]
			prev := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			current = prev + strings.Repeat(current, count)
		default:
			current += string(ch)
		}
	}
	return current
}

func main() {
	fmt.Println(decodeString("3[a]2[bc]"))   // "aaabcbc"
	fmt.Println(decodeString("3[a2[c]]"))    // "accaccacc"
	fmt.Println(decodeString("2[abc]3[cd]ef")) // "abcabccdcdcdef"
}
```

**Time Complexity:** O(n * maxRepeat) where n is the length of the output. **Space Complexity:** O(n) for the stacks.

#### Question 16: Design a Cross-Device Sync Conflict Resolver (Hard - Apple-Specific)

*This is a genuine Apple domain problem. iCloud syncs across billions of devices and must handle conflicts gracefully.*

**Key Insight:** Use vector clocks to detect conflicts. When two devices modify the same record concurrently, the system must detect this (neither vector clock dominates the other) and apply a deterministic resolution strategy.

```go
package main

import "fmt"

// VectorClock tracks causal ordering across multiple devices.
type VectorClock map[string]uint64

func (vc VectorClock) Increment(deviceID string) {
	vc[deviceID]++
}

func (vc VectorClock) Merge(other VectorClock) {
	for device, tick := range other {
		if tick > vc[device] {
			vc[device] = tick
		}
	}
}

// Dominates returns true if vc causally dominates other
// (every component is >= and at least one is strictly >).
func (vc VectorClock) Dominates(other VectorClock) bool {
	hasStrict := false
	for device, tick := range other {
		if vc[device] < tick {
			return false
		}
		if vc[device] > tick {
			hasStrict = true
		}
	}
	for device, tick := range vc {
		if other[device] < tick {
			hasStrict = true
		}
	}
	return hasStrict
}

// Concurrent returns true if neither clock dominates the other.
func (vc VectorClock) Concurrent(other VectorClock) bool {
	return !vc.Dominates(other) && !other.Dominates(vc)
}

func (vc VectorClock) Clone() VectorClock {
	clone := make(VectorClock, len(vc))
	for k, v := range vc {
		clone[k] = v
	}
	return clone
}

// SyncRecord represents a versioned record in the sync system.
type SyncRecord struct {
	Key       string
	Value     string
	Clock     VectorClock
	DeviceID  string
	Timestamp int64 // used as tiebreaker
}

// ConflictResolver determines the winning record when a conflict occurs.
type ConflictResolver struct{}

// Resolve takes two concurrent records and returns the winner.
// Strategy: last-writer-wins with device ID as deterministic tiebreaker.
func (cr *ConflictResolver) Resolve(a, b SyncRecord) SyncRecord {
	if a.Clock.Dominates(b.Clock) {
		return a
	}
	if b.Clock.Dominates(a.Clock) {
		return b
	}
	// Concurrent - use timestamp, then device ID as tiebreaker
	if a.Timestamp > b.Timestamp {
		return a
	}
	if b.Timestamp > a.Timestamp {
		return b
	}
	if a.DeviceID > b.DeviceID {
		return a
	}
	return b
}

func main() {
	// Device A and Device B both modify the same record concurrently
	clockA := VectorClock{"deviceA": 2, "deviceB": 1}
	clockB := VectorClock{"deviceA": 1, "deviceB": 2}

	recordA := SyncRecord{Key: "doc1", Value: "edit from iPhone", Clock: clockA, DeviceID: "deviceA", Timestamp: 1000}
	recordB := SyncRecord{Key: "doc1", Value: "edit from Mac", Clock: clockB, DeviceID: "deviceB", Timestamp: 1001}

	fmt.Println("Concurrent?", clockA.Concurrent(clockB)) // true

	resolver := &ConflictResolver{}
	winner := resolver.Resolve(recordA, recordB)
	fmt.Printf("Winner: %q from %s\n", winner.Value, winner.DeviceID)
}
```

**Time Complexity:** O(d) per comparison where d is the number of devices. **Space Complexity:** O(d) per vector clock.

#### Question 17: Binary Tree Maximum Path Sum (Hard)

*Apple asks this frequently for its difficulty and its relevance to tree-structured data (file systems, UI hierarchies).*

**Key Insight:** At each node, compute the maximum path sum that passes through it (left + node + right) and the maximum path sum that can be extended upward (node + max(left, right)). Track the global maximum.

```go
package main

import (
	"fmt"
	"math"
)

type TreeNode struct {
	Val   int
	Left  *TreeNode
	Right *TreeNode
}

func maxPathSum(root *TreeNode) int {
	maxSum := math.MinInt64

	var dfs func(node *TreeNode) int
	dfs = func(node *TreeNode) int {
		if node == nil {
			return 0
		}

		left := max(dfs(node.Left), 0)
		right := max(dfs(node.Right), 0)

		// Path through this node
		pathSum := node.Val + left + right
		if pathSum > maxSum {
			maxSum = pathSum
		}

		// Return max contribution to parent
		if left > right {
			return node.Val + left
		}
		return node.Val + right
	}

	dfs(root)
	return maxSum
}

func main() {
	root := &TreeNode{-10,
		&TreeNode{9, nil, nil},
		&TreeNode{20, &TreeNode{15, nil, nil}, &TreeNode{7, nil, nil}},
	}
	fmt.Println(maxPathSum(root)) // 42 (15 + 20 + 7)
}
```

**Time Complexity:** O(n). **Space Complexity:** O(h) where h is tree height.

#### Question 18: Design a Compact Trie for Autocomplete (Medium-Hard)

*Apple uses trie-based autocomplete in Spotlight, keyboard predictions, and Siri. This tests space optimization through path compression.*

**Key Insight:** A compressed (Patricia) trie merges single-child chains into single edges, dramatically reducing memory for sparse key sets.

```go
package main

import (
	"fmt"
	"sort"
	"strings"
)

type TrieNode struct {
	children map[byte]*TrieNode
	isEnd    bool
	word     string
	freq     int // for ranking autocomplete results
}

type AutocompleteTrie struct {
	root *TrieNode
}

func NewAutocompleteTrie() *AutocompleteTrie {
	return &AutocompleteTrie{root: &TrieNode{children: make(map[byte]*TrieNode)}}
}

func (t *AutocompleteTrie) Insert(word string, freq int) {
	node := t.root
	for i := 0; i < len(word); i++ {
		ch := word[i]
		if _, ok := node.children[ch]; !ok {
			node.children[ch] = &TrieNode{children: make(map[byte]*TrieNode)}
		}
		node = node.children[ch]
	}
	node.isEnd = true
	node.word = word
	node.freq = freq
}

// Autocomplete returns the top-k completions for the given prefix, ranked by frequency.
func (t *AutocompleteTrie) Autocomplete(prefix string, k int) []string {
	node := t.root
	for i := 0; i < len(prefix); i++ {
		child, ok := node.children[prefix[i]]
		if !ok {
			return nil
		}
		node = child
	}

	// Collect all words under this prefix
	type wordFreq struct {
		word string
		freq int
	}
	var results []wordFreq

	var collect func(n *TrieNode)
	collect = func(n *TrieNode) {
		if n.isEnd {
			results = append(results, wordFreq{n.word, n.freq})
		}
		for _, child := range n.children {
			collect(child)
		}
	}
	collect(node)

	// Sort by frequency descending
	sort.Slice(results, func(i, j int) bool {
		return results[i].freq > results[j].freq
	})

	topK := make([]string, 0, k)
	for i := 0; i < len(results) && i < k; i++ {
		topK = append(topK, results[i].word)
	}
	return topK
}

func main() {
	trie := NewAutocompleteTrie()
	words := map[string]int{
		"apple": 100, "application": 80, "apply": 60, "app": 120,
		"banana": 50, "band": 30, "aperture": 40,
	}
	for word, freq := range words {
		trie.Insert(word, freq)
	}

	results := trie.Autocomplete("app", 3)
	fmt.Println("app ->", strings.Join(results, ", ")) // app, apple, application
	results = trie.Autocomplete("ban", 2)
	fmt.Println("ban ->", strings.Join(results, ", ")) // banana, band
}
```

**Time Complexity:** O(L) for insert where L is word length. O(P + N log N) for autocomplete where P is prefix length and N is results count. **Space Complexity:** O(total characters across all words).

#### Question 19: Minimum Window Substring (Hard)

*Classic sliding window problem at hard difficulty. Apple expects clean, bug-free solutions.*

**Key Insight:** Expand the window right until all characters are covered, then contract from the left to find the minimum. Use a frequency map to track coverage.

```go
package main

import (
	"fmt"
	"math"
)

func minWindow(s, t string) string {
	if len(s) == 0 || len(t) == 0 || len(s) < len(t) {
		return ""
	}

	need := make(map[byte]int)
	for i := 0; i < len(t); i++ {
		need[t[i]]++
	}

	have := make(map[byte]int)
	formed := 0
	required := len(need)

	minLen := math.MaxInt64
	minStart := 0
	left := 0

	for right := 0; right < len(s); right++ {
		ch := s[right]
		have[ch]++

		if need[ch] > 0 && have[ch] == need[ch] {
			formed++
		}

		for formed == required {
			windowLen := right - left + 1
			if windowLen < minLen {
				minLen = windowLen
				minStart = left
			}

			leftCh := s[left]
			have[leftCh]--
			if need[leftCh] > 0 && have[leftCh] < need[leftCh] {
				formed--
			}
			left++
		}
	}

	if minLen == math.MaxInt64 {
		return ""
	}
	return s[minStart : minStart+minLen]
}

func main() {
	fmt.Println(minWindow("ADOBECODEBANC", "ABC")) // "BANC"
	fmt.Println(minWindow("a", "a"))                // "a"
	fmt.Println(minWindow("a", "aa"))               // ""
}
```

**Time Complexity:** O(n + m) where n is len(s) and m is len(t). **Space Complexity:** O(m) for the frequency maps.

#### Question 20: Design a Concurrent File Sync Engine (Hard - Apple-Specific)

*This is a system-level design-and-code hybrid that Apple asks senior candidates. It combines concurrency, state management, and practical engineering.*

**Key Insight:** Use a worker pool with priority-based scheduling. Files are queued for sync, prioritized by recency and user interaction. A state machine tracks each file through pending, syncing, synced, and conflict states.

```go
package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type SyncState int

const (
	SyncPending  SyncState = iota
	SyncInFlight
	SyncComplete
	SyncConflict
	SyncFailed
)

type SyncItem struct {
	Path       string
	Priority   int // lower = higher priority
	ModifiedAt time.Time
	State      SyncState
	RetryCount int
}

type SyncEngine struct {
	mu       sync.Mutex
	queue    []*SyncItem
	states   map[string]*SyncItem
	workers  int
	maxRetry int
	wg       sync.WaitGroup
	sem      chan struct{}
}

func NewSyncEngine(workers, maxRetry int) *SyncEngine {
	return &SyncEngine{
		states:   make(map[string]*SyncItem),
		workers:  workers,
		maxRetry: maxRetry,
		sem:      make(chan struct{}, workers),
	}
}

// Enqueue adds a file to the sync queue.
func (se *SyncEngine) Enqueue(path string, priority int) {
	se.mu.Lock()
	defer se.mu.Unlock()

	item, exists := se.states[path]
	if exists && item.State == SyncInFlight {
		return // already syncing
	}

	item = &SyncItem{
		Path:       path,
		Priority:   priority,
		ModifiedAt: time.Now(),
		State:      SyncPending,
	}
	se.states[path] = item
	se.queue = append(se.queue, item)
}

// Process runs the sync engine until the context is canceled.
func (se *SyncEngine) Process(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			se.wg.Wait()
			return
		default:
		}

		item := se.dequeue()
		if item == nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}

		se.sem <- struct{}{}
		se.wg.Add(1)
		go func(it *SyncItem) {
			defer se.wg.Done()
			defer func() { <-se.sem }()
			se.syncFile(ctx, it)
		}(item)
	}
}

func (se *SyncEngine) dequeue() *SyncItem {
	se.mu.Lock()
	defer se.mu.Unlock()

	if len(se.queue) == 0 {
		return nil
	}

	// Find highest priority (lowest number) item
	bestIdx := 0
	for i := 1; i < len(se.queue); i++ {
		if se.queue[i].Priority < se.queue[bestIdx].Priority {
			bestIdx = i
		}
	}

	item := se.queue[bestIdx]
	se.queue = append(se.queue[:bestIdx], se.queue[bestIdx+1:]...)
	item.State = SyncInFlight
	return item
}

func (se *SyncEngine) syncFile(ctx context.Context, item *SyncItem) {
	// Simulate file sync (in production, this uploads/downloads the file)
	select {
	case <-ctx.Done():
		se.markState(item, SyncPending)
		return
	case <-time.After(50 * time.Millisecond):
	}

	// Simulate occasional failure
	if item.RetryCount == 0 && item.Priority > 5 {
		item.RetryCount++
		if item.RetryCount <= se.maxRetry {
			se.mu.Lock()
			item.State = SyncPending
			se.queue = append(se.queue, item)
			se.mu.Unlock()
			return
		}
		se.markState(item, SyncFailed)
		return
	}

	se.markState(item, SyncComplete)
}

func (se *SyncEngine) markState(item *SyncItem, state SyncState) {
	se.mu.Lock()
	defer se.mu.Unlock()
	item.State = state
}

// Status returns the sync state of all tracked items.
func (se *SyncEngine) Status() map[string]SyncState {
	se.mu.Lock()
	defer se.mu.Unlock()

	result := make(map[string]SyncState, len(se.states))
	for path, item := range se.states {
		result[path] = item.State
	}
	return result
}

func main() {
	engine := NewSyncEngine(4, 3)

	engine.Enqueue("/docs/report.pages", 1) // high priority
	engine.Enqueue("/photos/vacation.jpg", 5)
	engine.Enqueue("/music/song.mp3", 10) // low priority

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go engine.Process(ctx)

	time.Sleep(1 * time.Second)
	for path, state := range engine.Status() {
		fmt.Printf("%s: %d\n", path, state)
	}
}
```

**Time Complexity:** O(n) for dequeue (could be optimized with a heap). **Space Complexity:** O(n) for the queue and state map.

### System Design Topics Apple Favors

**Top 5 System Design Questions Asked at Apple:**

1. **Design iCloud Photo Sync** - Cross-device sync for billions of photos. Emphasis on conflict resolution, bandwidth optimization (sync thumbnails first, full resolution on demand), offline-first architecture, and end-to-end encryption. Apple interviewers probe deeply on how you handle the device having limited storage while the cloud has the full library.

2. **Design a Real-Time Location Service (Apple Maps)** - Ingest location data from millions of devices, compute ETAs, detect traffic patterns, and serve location queries at low latency. Focus on geospatial indexing (R-trees, geohashing), real-time stream processing, and privacy (Apple anonymizes location data aggressively).

3. **Design an App Store Search and Ranking System** - Index millions of apps, rank by relevance/quality/popularity, handle personalization, and serve search results in under 100ms. Apple cares about the quality of results (not just speed) and asks about abuse prevention (fake reviews, keyword stuffing).

4. **Design a Push Notification Delivery System** - Deliver notifications to 2 billion+ devices globally with guaranteed delivery, priority levels, and batching for battery efficiency. Focus on device state tracking (online/offline), persistent connections, and graceful degradation.

5. **Design a Media Processing Pipeline** - Ingest, transcode, package, and distribute audio/video content for Apple Music and Apple TV+. Emphasis on encoding efficiency, adaptive bitrate packaging, DRM integration, and CDN distribution.

**How deep they go:** Apple system design rounds are 45-60 minutes and go deeper than most companies on specific components. Rather than covering the entire system at a high level (as Google might), Apple interviewers often pick one component and drill down: "Let's focus on the conflict resolution layer. Walk me through every possible conflict scenario and how your design handles each one."

**What they look for:** Performance numbers (latency percentiles, throughput), reliability guarantees (what happens when a datacenter goes down?), privacy by design (is user data encrypted at rest and in transit? who has access?), and user experience impact (how does this design decision affect what the user sees on their device?).

### Behavioral Focus

Apple's behavioral interviews evaluate three core dimensions:

**Innovation and Craftsmanship:**
- "Tell me about something you built that you are genuinely proud of - not because of its scale, but because of its quality."
- "Describe a time you pushed for a higher standard of quality when the team wanted to ship faster."
- "How do you balance innovation with reliability? Give a specific example."
- Apple wants engineers who care about craft. The ideal answer demonstrates a deep personal investment in quality, not just hitting metrics.

**Attention to Detail:**
- "Walk me through a bug you found that others missed. How did you find it?"
- "Describe a time when a small detail in your implementation had a big impact on the user experience."
- "How do you review code? What do you look for beyond correctness?"
- Apple expects you to notice things other engineers miss. Show that you read error messages, test edge cases, and care about the 1% of users who encounter unusual conditions.

**Collaboration in Small Teams:**
- "How do you handle disagreements with a teammate when there is no manager to mediate?"
- "Describe a time you had to depend on another team for a critical deliverable. How did you manage the dependency?"
- "Tell me about working on a project where secrecy was important. How did you handle communication?"
- Apple teams are small and tight-knit. Show that you communicate clearly, handle conflict maturely, and can work with limited information.

### Preparation Timeline (8-12 weeks)

| Week | Focus | Daily Hours | Key Activities |
|------|-------|-------------|----------------|
| 1-2 | Domain Research | 2-3h | Research target team's products and technical challenges. Study Apple's public technical talks (WWDC sessions on relevant topics). Understand the product deeply from a user perspective. |
| 3-4 | Core Coding (Easy-Medium) | 3-4h | Focus on clean, well-named solutions. Practice explaining every design decision. Solve 4-5 problems daily with deep follow-up discussion. |
| 5-6 | Advanced Coding (Medium-Hard) | 3-4h | Trees, graphs, sliding window, dynamic programming. Emphasis on system-level problems: memory allocators, ring buffers, concurrent data structures. |
| 7-8 | System Design | 3-4h | Performance-focused system design. Practice designing Apple-specific systems (sync, media, search). Study offline-first architecture patterns. |
| 9-10 | Go Internals + Domain Depth | 2-3h | Memory model, GC tuning, scheduler internals. Deep dive into the target team's domain (storage, networking, ML, etc.). Build small prototypes. |
| 11-12 | Mock Interviews + Integration | 3-4h | Full-loop mock interviews with conversational follow-ups. Practice the hiring manager round. Prepare 6+ detailed stories about past work with emphasis on quality and detail. |

**Key differences from generic FAANG prep:** Spend significantly more time on domain research (weeks 1-2 and 9-10) than you would for Google or Meta. Apple's team-specific process means generic algorithm grinding is less valuable than understanding the problem domain. Practice conversational-style interviews where the interviewer challenges your decisions - Apple interviewers rarely just ask "optimize this."

### Insider Tips

**What most candidates get wrong:**
- Treating the Apple interview like a Google interview. Apple does not care if you can solve hard LeetCode problems in 15 minutes. They care if you can write clean code and discuss your decisions intelligently.
- Not researching the specific team. Showing up to a CloudKit interview without understanding sync protocols or to a Maps interview without understanding geospatial indexing is a strong negative signal.
- Ignoring the hiring manager round. At Apple, this is a real evaluation round, not a formality. Candidates who prepare only for technical rounds and wing the HM round get rejected.

**What makes a "strong hire" signal:**
- Writing code that looks like it could go into production - proper error handling, meaningful names, logical structure.
- Asking insightful follow-up questions that show you are thinking about the bigger system, not just the immediate problem.
- Demonstrating genuine enthusiasm for Apple products and the specific team's mission. Apple engineers are passionate about their work and they want colleagues who share that passion.
- Handling deep follow-up questions gracefully. When the interviewer asks "what happens if there are 10 million of these?", giving a thoughtful, quantitative answer rather than a vague hand-wave.

**Red flags that lead to rejection:**
- Sloppy code with poor naming and missing edge cases. This signals misalignment with Apple's craftsmanship culture.
- Trying to extract confidential project information during the interview. Apple takes secrecy seriously and tests for discretion.
- Showing arrogance or dismissing the interviewer's suggestions. Apple teams are collaborative, and "brilliant jerks" are filtered out.
- Not having questions for the interviewer, or asking only about compensation and work-life balance. Apple interviewers want to see intellectual curiosity about the technical work.

**How to stand out from other candidates:**
- Build something related to the team's domain before the interview. A personal project that demonstrates relevant expertise (e.g., a sync engine prototype for a CloudKit team interview) creates a strong signal.
- Bring up Apple's design philosophy in your answers: efficiency, privacy, user experience. Show that you understand Apple's values, not just its technology.
- When discussing system design, always connect back to the user experience. "This reduces P99 latency from 800ms to 200ms" is good. "This means the user sees their photo appear on their Mac within half a second of taking it on their iPhone" is Apple-level thinking.


### Junior → FAANG: Preparing for Apple Interviews

Apple's interview culture values craftsmanship, attention to detail, and a long-term orientation. Coding interviews at Apple tend to be practical: they often use real-world scenarios rather than abstract algorithmic puzzles, and they care about code quality (naming, structure, error handling) in addition to correctness. Behavioral interviews probe for ownership and impact on product quality. Know Apple's product line and the specific frameworks or systems relevant to the team you are targeting.

### Senior @ FAANG: Apple Senior Engineer Interview: Quality Obsession and Platform Thinking

Apple's engineering culture at the senior level prizes the quality of the engineering decision over the speed of the decision. This is different from Meta's move-fast culture and requires different behavioral story framing. At senior levels, Apple interviewers probe for evidence that you have pushed back on timelines for quality reasons, that you have caught and fixed subtle bugs that others missed, and that you think about the end user experience at a detailed level. For system design, Apple's bar includes deep knowledge of Apple-specific constraints when relevant to the role: Core Data, Metal, XPC, and privacy-preserving APIs. At the staff level, Apple interviews heavily on technical leadership: your ability to set the technical direction for a product feature or platform, align multiple engineering teams, and deliver quality at scale.

---
