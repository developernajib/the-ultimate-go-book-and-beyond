## 117.4 Memory Systems

Agents need memory to maintain context across interactions.

### Short-Term Memory (Conversation Buffer)

Short-term memory is the conversation itself: a bounded window of recent messages that the agent replays to the model on every turn. `BufferMemory` below is deliberately the dumbest thing that works, a slice with a cap and a mutex. The cap is what matters. Without it, every turn appends to a slice that is resent in full on the next turn, so context length and cost per step grow with the length of the run.

The mutex is not decoration either. One agent's loop is sequential, but a supervisor sharing a memory across parallel subagents will call `Add` from several goroutines at once.

```go
// pkg/agent/memory/buffer.go
package memory

import (
    "context"
    "sync"
    "time"

    "agent/pkg/agent"
)

// BufferMemory stores recent messages in memory
type BufferMemory struct {
    messages []agent.Message
    maxSize  int
    mu       sync.RWMutex
}

// NewBufferMemory creates a new buffer memory with size limit
func NewBufferMemory(maxSize int) *BufferMemory {
    return &BufferMemory{
        messages: make([]agent.Message, 0, maxSize),
        maxSize:  maxSize,
    }
}

func (b *BufferMemory) Add(ctx context.Context, msg agent.Message) error {
    b.mu.Lock()
    defer b.mu.Unlock()

    msg.Timestamp = time.Now()
    b.messages = append(b.messages, msg)

    // Trim to max size, keeping most recent
    if len(b.messages) > b.maxSize {
        b.messages = b.messages[len(b.messages)-b.maxSize:]
    }

    return nil
}

func (b *BufferMemory) GetRecent(ctx context.Context, n int) ([]agent.Message, error) {
    b.mu.RLock()
    defer b.mu.RUnlock()

    if n <= 0 || n >= len(b.messages) {
        // Return all messages
        result := make([]agent.Message, len(b.messages))
        copy(result, b.messages)
        return result, nil
    }

    // Return last n messages
    result := make([]agent.Message, n)
    copy(result, b.messages[len(b.messages)-n:])
    return result, nil
}

func (b *BufferMemory) Search(ctx context.Context, query string, limit int) ([]agent.Message, error) {
    // Buffer memory doesn't support semantic search
    // Just return recent messages
    return b.GetRecent(ctx, limit)
}

func (b *BufferMemory) Clear(ctx context.Context) error {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.messages = make([]agent.Message, 0, b.maxSize)
    return nil
}
```

### Long-Term Memory (Vector Store)

Long-term memory persists past conversations and retrieved facts as vector embeddings so the agent can recall semantically relevant context from earlier sessions that have since been evicted from the short-term buffer. On each turn, the agent queries the vector store with the current message to retrieve the top-k most relevant memories, which are prepended to the prompt as additional context.

```go
// pkg/agent/memory/vector.go
package memory

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "agent/pkg/agent"
    "agent/pkg/vectordb"
)

// VectorMemory stores messages with embeddings for semantic search
type VectorMemory struct {
    vectorStore vectordb.VectorStore
    embedder    Embedder
    buffer      *BufferMemory // Keep recent messages in memory too
}

// Embedder generates vector embeddings from text
type Embedder interface {
    Embed(ctx context.Context, text string) ([]float32, error)
}

// NewVectorMemory creates vector-backed memory
func NewVectorMemory(store vectordb.VectorStore, embedder Embedder, bufferSize int) *VectorMemory {
    return &VectorMemory{
        vectorStore: store,
        embedder:    embedder,
        buffer:      NewBufferMemory(bufferSize),
    }
}

func (v *VectorMemory) Add(ctx context.Context, msg agent.Message) error {
    // Stamp the message here, before it is handed to anything else.
    // BufferMemory.Add takes msg by value and sets the timestamp on its own
    // copy, which does nothing for the msg still held in this function. Relying
    // on that would leave the zero time in the vector metadata below, and a
    // zero time silently formats as year 1 rather than failing.
    if msg.Timestamp.IsZero() {
        msg.Timestamp = time.Now()
    }

    // Add to buffer for fast recent access
    if err := v.buffer.Add(ctx, msg); err != nil {
        return err
    }

    // Generate embedding
    embedding, err := v.embedder.Embed(ctx, msg.Content)
    if err != nil {
        return fmt.Errorf("failed to generate embedding: %w", err)
    }

    // Store in vector database
    doc := vectordb.Document{
        ID:     fmt.Sprintf("msg_%d", time.Now().UnixNano()),
        Vector: embedding,
        Metadata: vectordb.Metadata{
            "role":      msg.Role,
            "timestamp": msg.Timestamp.Unix(),
        },
        Text:      msg.Content,
        CreatedAt: msg.Timestamp,
    }

    if err := v.vectorStore.Upsert(ctx, []vectordb.Document{doc}); err != nil {
        return fmt.Errorf("failed to store in vector db: %w", err)
    }

    return nil
}

func (v *VectorMemory) GetRecent(ctx context.Context, n int) ([]agent.Message, error) {
    // Fast path: get from buffer
    return v.buffer.GetRecent(ctx, n)
}

func (v *VectorMemory) Search(ctx context.Context, query string, limit int) ([]agent.Message, error) {
    // Generate query embedding
    queryVec, err := v.embedder.Embed(ctx, query)
    if err != nil {
        return nil, fmt.Errorf("failed to embed query: %w", err)
    }

    // Search vector store
    resp, err := v.vectorStore.Query(ctx, queryVec, limit, nil)
    if err != nil {
        return nil, fmt.Errorf("vector search failed: %w", err)
    }

    // Convert results to messages
    messages := make([]agent.Message, len(resp.Results))
    for i, result := range resp.Results {
        role, _ := result.Metadata["role"].(string)

        messages[i] = agent.Message{
            Role:      role,
            Content:   result.Text,
            Timestamp: time.Unix(metadataInt64(result.Metadata["timestamp"]), 0),
        }
    }

    return messages, nil
}

// metadataInt64 reads a number out of metadata that may have made a round trip
// through JSON. Add stored an int64, but a store that serialises to JSON hands
// it back as float64, because JSON has one number type and encoding/json
// decodes it into any as float64.
//
// A bare .(int64) assertion is the bug this exists to prevent. It compiles, it
// works against an in-memory fake in unit tests, and it fails against the real
// store in production. Worse, with the comma-ok form it fails silently: ok is
// false, the value stays zero, and every recalled memory is dated 1970.
func metadataInt64(v any) int64 {
    switch n := v.(type) {
    case int64:
        return n
    case float64:
        return int64(n)
    case int:
        return int64(n)
    case json.Number:
        i, _ := n.Int64()
        return i
    default:
        return 0
    }
}

func (v *VectorMemory) Clear(ctx context.Context) error {
    if err := v.buffer.Clear(ctx); err != nil {
        return err
    }

    // Clear the durable half too, and report it if you cannot. Returning nil
    // after wiping only the buffer would be the worst outcome available: the
    // caller is told the memory is cleared while every message survives in the
    // vector store. When that caller is a GDPR erasure request, a Clear that
    // lies is a compliance incident rather than a missing feature.
    if err := v.vectorStore.DeleteAll(ctx); err != nil {
        return fmt.Errorf("buffer cleared but vector store retains data: %w", err)
    }

    return nil
}
```

### Junior → FAANG: Agent Memory as a Context Management Problem

Agent memory is fundamentally a context management problem: how do you give the agent the right information at each step without exceeding the LLM's context window or inflating the cost per step? Short-term memory (the current conversation history) grows with each step and must be managed explicitly: summarize or truncate when it approaches the context limit. Long-term memory (a vector store of past interactions and domain knowledge) must be retrieved selectively: embedding the current state and finding the most relevant past memories to include in the context.

The two most important design decisions for agent memory are: what to store (every step is too expensive, key facts and decisions are usually sufficient) and how to retrieve (keyword search is fast, semantic search is more relevant). Practice implementing both a simple short-term memory (a slice of messages with a maximum length and truncation logic) and a long-term memory (a vector store client with embed-and-store for writes and embed-and-search for reads). Understanding the implementation makes you able to discuss memory tradeoffs in interviews with specificity rather than vague generalities.

For interview prep, know the difference between episodic memory (records of specific past interactions), semantic memory (general knowledge about the domain), and procedural memory (knowledge of how to perform tasks). Production agent memory systems benefit from distinguishing these types and retrieving them selectively based on what the current task requires.

### Senior @ FAANG: Memory Architecture for Long-Running Agents

Long-running agents (agents that work on a task over days or weeks rather than minutes) require production-grade memory architecture. The conversation history cannot grow unboundedly: implement a summarization step that condenses the oldest portion of the history into a summary message when the history exceeds a token threshold. The summary must preserve the key decisions and intermediate results while discarding the detailed reasoning chains that are no longer needed. Designing this summarization step to run automatically at the right threshold, without disrupting the agent's reasoning, is a senior-level production engineering concern.

Memory consistency is a distributed systems problem for multi-agent systems. When multiple agents share a long-term memory (a vector store), concurrent writes can produce inconsistent states: agent A stores a fact, agent B retrieves stale data from before agent A's write, agent B makes a decision based on stale data. Designing memory access protocols that provide sufficient consistency for agent decision-making without creating performance bottlenecks requires the same analysis as any distributed systems consistency problem: what are the consistency requirements for each type of memory access, and what synchronization mechanisms are proportionate to those requirements?

At L6, agent memory governance includes privacy and data retention. An agent's long-term memory may contain sensitive user data (personal information shared in a conversation, confidential documents retrieved from a tool), and this data must be subject to the same retention and deletion policies as other personal data. Designing the memory store to support per-user deletion (for GDPR right-to-erasure compliance) and per-session expiration (for data minimization) requires careful data modeling and integration with the organization's privacy infrastructure. These requirements must be designed into the memory architecture from the start, not added retroactively after the privacy team discovers that agent memories contain unerased personal data.
