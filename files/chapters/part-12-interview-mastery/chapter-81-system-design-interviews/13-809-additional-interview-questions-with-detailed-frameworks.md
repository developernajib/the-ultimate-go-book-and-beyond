## 81.11 Additional Interview Questions with Detailed Frameworks

### Question 1: "Walk me through how you'd approach designing a notification system"

**What Interviewers Are Testing**:
- Ability to gather requirements
- Understanding of distributed systems
- Trade-off analysis
- Real-time vs batch processing decisions

**Framework for Answering**:

```
STEP 1: CLARIFY REQUIREMENTS (2-3 minutes)

Questions to ask:
- What types of notifications? (email, push, SMS, in-app)
- Volume: How many notifications per day?
- Latency: Real-time required or batching OK?
- Priority levels needed?
- Retry/delivery guarantees?

STEP 2: HIGH-LEVEL DESIGN (5 minutes)

┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│ Event Source │────►│ Notification │────►│ Channel Services │
│  (Services)  │     │   Service    │     │ (Email/Push/SMS) │
└──────────────┘     └──────────────┘     └──────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  User Prefs  │
                    │   Database   │
                    └──────────────┘

Key components:
1. Event ingestion (Kafka for async processing)
2. Notification service (routing logic)
3. User preferences (what/when/how to notify)
4. Channel handlers (email, push, SMS)
5. Delivery tracking and retry

STEP 3: DEEP DIVE (10-15 minutes)

Pick 2-3 areas:
- Message queue design (ordering, deduplication)
- User preference storage and lookup
- Rate limiting to prevent spam
- Delivery tracking and retry logic
- Priority queue for urgent notifications
```

**Example Strong Answer**:

"Let me start by understanding the requirements. What types of notifications are we supporting - email, push, SMS, all three? What's the expected volume? And are there latency requirements - do some notifications need to be instant while others can be batched?"

[After clarification]

"Based on those requirements, here's my high-level design. I'll use an event-driven architecture with Kafka as the backbone.

Events flow in from various services - user actions, system alerts, etc. The Notification Service consumes these events and makes routing decisions: which user gets notified, through which channel, and when.

For routing, I need a User Preferences service that stores each user's notification settings - 'email me daily digests, push for urgent only, no SMS.' This needs to be fast, so I'd cache preferences in Redis.

Each channel has its own handler: Email Handler talks to SendGrid, Push Handler talks to FCM/APNS, SMS Handler talks to Twilio. This separation means I can scale channels independently and a failure in one doesn't affect others.

For delivery guarantees, I'd use at-least-once delivery with deduplication. Each notification gets a unique ID. The channel handler marks it 'delivered' only after confirmation. Failed deliveries go to a retry queue with exponential backoff.

The key trade-off: I'm choosing eventual consistency for speed. A notification might be delayed by a few seconds during high load, but we won't drop any. For truly urgent notifications - like password reset - I'd add a priority queue that bypasses the normal queue."

---

### Question 2: "Design a distributed task scheduler (like cron)"

**What Interviewers Are Testing**:
- Understanding of distributed systems coordination
- Handling failure and recovery
- Time-sensitive operations at scale
- Leader election concepts

**Framework for Answering**:

```
REQUIREMENTS CLARIFICATION:

Functional:
- Schedule tasks at specific times or intervals
- Execute tasks exactly once
- Handle task failures and retries
- Support millions of scheduled tasks

Non-functional:
- High availability (no single point of failure)
- Precision: Execute within X seconds of scheduled time
- Scale: 100K tasks triggering per second at peak

HIGH-LEVEL ARCHITECTURE:

┌──────────────────────────────────────────────────────────────────┐
│                    DISTRIBUTED TASK SCHEDULER                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐      │
│  │    API       │────►│   Task       │────►│  Task Queue  │      │
│  │   Server     │     │   Store      │     │   (Kafka)    │      │
│  └──────────────┘     │  (Postgres)  │     └──────────────┘      │
│                       └──────────────┘            │              │
│                                                   │              │
│  ┌──────────────────────────────────────────────┐ │              │
│  │           Scheduler Workers                  │ │              │
│  │  ┌────────┐  ┌────────┐  ┌────────┐          │ │              │
│  │  │Worker 1│  │Worker 2│  │Worker 3│ ...      │◄┘              │
│  │  │(Leader)│  │        │  │        │          │                │
│  │  └────────┘  └────────┘  └────────┘          │                │
│  └──────────────────────────────────────────────┘                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

KEY DESIGN DECISIONS:

1. Task Storage: Time-bucketed tables
   - Partition by minute/hour
   - Index on (bucket, scheduled_time)
   - Workers poll specific buckets

2. Coordination: Leader election via Zookeeper/etcd
   - One leader per bucket
   - Prevents duplicate execution

3. Exactly-once execution:
   - Optimistic locking with version
   - Task state machine: PENDING → RUNNING → COMPLETED

4. Scaling:
   - Shard by time buckets
   - Each shard has leader + followers
   - Add shards for more capacity
```

**Complete Go Implementation Snippet**:

```go
package scheduler

import (
    "context"
    "log/slog"
    "sync"
    "time"
)

// Task represents a scheduled task
type Task struct {
    ID           string
    ScheduledAt  time.Time
    Payload      []byte
    Status       TaskStatus
    Version      int64
    RetryCount   int
}

type TaskStatus string

const (
    StatusPending   TaskStatus = "PENDING"
    StatusRunning   TaskStatus = "RUNNING"
    StatusCompleted TaskStatus = "COMPLETED"
    StatusFailed    TaskStatus = "FAILED"
)

// Scheduler manages task execution
type Scheduler struct {
    store    TaskStore
    executor TaskExecutor
    leaderMu sync.Mutex
    isLeader bool
}

// Run starts the scheduler loop
func (s *Scheduler) Run(ctx context.Context) error {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if s.isLeader {
                s.processDueTasks(ctx)
            }
        }
    }
}

func (s *Scheduler) processDueTasks(ctx context.Context) {
    // Get tasks due in the next second
    now := time.Now()
    tasks, err := s.store.GetDueTasks(ctx, now, now.Add(time.Second))
    if err != nil {
        slog.Error("failed to get due tasks", "error", err)
        return
    }

    for _, task := range tasks {
        // Try to claim the task with optimistic locking
        claimed, err := s.store.ClaimTask(ctx, task.ID, task.Version)
        if err != nil || !claimed {
            continue // Another worker got it
        }

        // Execute in goroutine
        go s.executeTask(ctx, task)
    }
}

func (s *Scheduler) executeTask(ctx context.Context, task *Task) {
    err := s.executor.Execute(ctx, task)

    if err != nil {
        if task.RetryCount < 3 {
            // Schedule retry with exponential backoff
            retryAt := time.Now().Add(time.Duration(1<<task.RetryCount) * time.Minute)
            s.store.RetryTask(ctx, task.ID, retryAt)
        } else {
            s.store.FailTask(ctx, task.ID, err.Error())
        }
        return
    }

    s.store.CompleteTask(ctx, task.ID)
}
```

---

### Question 3: "Design a search autocomplete system"

**What Interviewers Are Testing**:
- Trie data structure knowledge
- Caching and optimization
- Real-time ranking
- Handling scale efficiently

**Framework for Answering**:

```
REQUIREMENTS:

Functional:
- Return top 10 suggestions as user types
- Results based on popularity/relevance
- Support 100M+ search terms
- Update rankings based on new searches

Non-functional:
- Latency < 50ms
- High availability
- Handle 100K QPS

DATA STRUCTURE: TRIE

┌──────────────────────────────────────────────────────────────────┐
│                         TRIE STRUCTURE                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                          (root)                                  │
│                         /      \                                 │
│                        t        c                                │
│                       /          \                               │
│                      e            a                              │
│                     / \            \                             │
│                    s   a           t [top: cat, cats, catch]     │
│                   /     \                                        │
│                  t       m [top: team, teams]                    │
│  [top: test]    ↓                                                │
│             [top: tesla]                                         │
│                                                                  │
│  Each node stores:                                               │
│  - Children map                                                  │
│  - Top K suggestions (precomputed)                               │
│  - Frequency for ranking                                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

ARCHITECTURE:

┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Client     │────►│    CDN       │────►│  API Server  │
│              │     │   Cache      │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
                                                │
                           ┌────────────────────┼────────────────┐
                           │                    │                │
                           ▼                    ▼                ▼
                    ┌──────────────┐    ┌──────────────┐  ┌──────────────┐
                    │    Redis     │    │    Trie      │  │   Ranking    │
                    │   (Hot)      │    │   Service    │  │   Service    │
                    └──────────────┘    └──────────────┘  └──────────────┘
```

**Go Implementation**:

```go
package autocomplete

import (
    "cmp"
    "slices"
    "sync"
)

type TrieNode struct {
    children map[rune]*TrieNode
    topK     []Suggestion
    isEnd    bool
    mu       sync.RWMutex
}

type Suggestion struct {
    Term   string
    Score  int64
}

type Trie struct {
    root *TrieNode
    k    int // Number of suggestions to return
}

func NewTrie(k int) *Trie {
    return &Trie{
        root: &TrieNode{children: make(map[rune]*TrieNode)},
        k:    k,
    }
}

// Search returns top K suggestions for prefix
// Time: O(prefix length), precomputed results
func (t *Trie) Search(prefix string) []Suggestion {
    node := t.root

    for _, char := range prefix {
        node.mu.RLock()
        child, exists := node.children[char]
        node.mu.RUnlock()

        if !exists {
            return nil
        }
        node = child
    }

    node.mu.RLock()
    defer node.mu.RUnlock()
    return node.topK
}

// Insert adds or updates a term with its score
// Then propagates top K up the tree
func (t *Trie) Insert(term string, score int64) {
    node := t.root

    for _, char := range term {
        node.mu.Lock()
        if node.children[char] == nil {
            node.children[char] = &TrieNode{
                children: make(map[rune]*TrieNode),
            }
        }
        child := node.children[char]
        node.mu.Unlock()
        node = child
    }

    node.mu.Lock()
    node.isEnd = true
    node.mu.Unlock()

    // Update top K along the path
    t.updateTopK(term, score)
}

func (t *Trie) updateTopK(term string, score int64) {
    node := t.root

    for _, char := range term {
        node.mu.Lock()
        node.topK = t.addToTopK(node.topK, Suggestion{term, score})
        child := node.children[char]
        node.mu.Unlock()
        node = child
    }

    // Update the final node
    node.mu.Lock()
    node.topK = t.addToTopK(node.topK, Suggestion{term, score})
    node.mu.Unlock()
}

func (t *Trie) addToTopK(topK []Suggestion, s Suggestion) []Suggestion {
    // Find existing or add new
    found := false
    for i, existing := range topK {
        if existing.Term == s.Term {
            topK[i].Score = s.Score
            found = true
            break
        }
    }

    if !found {
        topK = append(topK, s)
    }

    // Sort by score descending (Go 1.21+ slices.SortFunc)
    slices.SortFunc(topK, func(a, b Suggestion) int {
        return cmp.Compare(b.Score, a.Score)
    })

    // Keep only top K
    if len(topK) > t.k {
        topK = topK[:t.k]
    }

    return topK
}
```


### Junior → FAANG: Practicing with Detailed Question Frameworks

Detailed question frameworks give you a repeatable structure to avoid blanking during an interview. The classic RESHADED acronym (Requirements, Estimation, Storage, High-level design, API design, Data model, Evaluation, Deep-dive) or similar mnemonics are tools for managing your time and ensuring you cover the major areas. Juniors often spend too long on estimation (which matters less at L4) and not enough on the data model and API design (which are more concrete and verifiable). Practice recognizing when an interviewer hints that they want you to move on: a good signal is when they stop asking follow-up questions on a topic.

### Senior @ FAANG: Framework Mastery and When to Break the Framework

Senior engineers know the frameworks well enough to deviate from them intentionally. In a bar-raiser interview, rigid adherence to a checklist can signal that you are following a recipe rather than thinking. The signal FAANG bar-raisers look for at L6 is whether you prioritize the right sub-problems for the specific prompt rather than running a fixed procedure. For a question about a rate limiter, the interesting conversation is not the high-level architecture but the token bucket versus sliding window versus leaky bucket trade-offs and the distributed coordination problem. For a question about a news feed, the fan-out write versus fan-out read decision is the crux. Staff-level concerns include designing frameworks that your team can reuse: internal design doc templates, reference architectures, and review checklists that encode institutional knowledge and raise the quality floor for everyone.

---
