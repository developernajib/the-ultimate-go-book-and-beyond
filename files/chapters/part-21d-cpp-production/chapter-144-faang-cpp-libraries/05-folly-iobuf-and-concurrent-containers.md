## Folly: IOBuf and Concurrent Containers

Network I/O at Meta's scale means processing hundreds of millions of messages per second. Copying data between buffers, even memcpy, becomes a measurable bottleneck. Folly's `IOBuf` eliminates that cost. Separately, coordinating shared state across thousands of threads requires containers that minimize lock contention. Folly provides these too.

### folly::IOBuf: Zero-Copy Buffer Chains

`folly::IOBuf` represents a contiguous byte buffer with a managed reference count. The key feature is that `IOBuf` instances can be **chained** into a linked list, forming a logical buffer that is physically scattered. Network protocol headers and payloads can live in separate buffers without copying them into a single contiguous region.

```cpp
#include <folly/io/IOBuf.h>
#include <folly/io/IOBufQueue.h>

// Allocate an IOBuf with 4096 bytes of capacity
std::unique_ptr<folly::IOBuf> buf = folly::IOBuf::create(4096);

// Write into the buffer's tail room
uint8_t* write_ptr = buf->writableTail();
size_t available = buf->tailroom();
// ... write `n` bytes into write_ptr ...
buf->append(n);  // advance the tail pointer by n bytes

// Read from the buffer
const uint8_t* data = buf->data();
size_t length = buf->length();

// Prepend a header without copying the body
auto header_buf = folly::IOBuf::create(16);
// ... fill header ...
header_buf->append(16);

// Chain: header_buf -> buf (linked list)
header_buf->prependChain(std::move(buf));
// header_buf is now a chain: traversal visits all nodes

// Iterate over chain nodes
const folly::IOBuf* current = header_buf.get();
do {
    process_bytes(current->data(), current->length());
    current = current->next();
} while (current != header_buf.get());

// Coalesce: merge chain into a single contiguous buffer (copies!)
// Use sparingly -- this is the fallback when you need contiguous memory
header_buf->coalesce();
```

### IOBufQueue: Incremental Buffer Construction

`IOBufQueue` is the idiomatic way to build up a buffer incrementally without knowing the final size upfront, exactly what a serializer needs.

```cpp
#include <folly/io/IOBufQueue.h>

folly::IOBufQueue queue(folly::IOBufQueue::cacheChainLength());

// Append grows the queue, reusing the last buffer's tailroom if possible
queue.append("HTTP/1.1 200 OK\r\n");
queue.append("Content-Type: application/json\r\n");
queue.append("\r\n");
queue.append(json_body);

// Move the entire chain out when done
std::unique_ptr<folly::IOBuf> response = queue.move();

// Total logical length across the chain
size_t total_len = response->computeChainDataLength();
```

In Go, `bytes.Buffer` is the closest equivalent, it also avoids repeated allocations by growing a backing slice. The difference is that `IOBufQueue` can produce a chain of buffers that is handed to the network stack's scatter/gather I/O (`sendmsg` with multiple `iovec` entries), achieving true zero-copy to the kernel.

### folly::ConcurrentHashMap: Lock-Free Read Path

`folly::ConcurrentHashMap<K,V>` provides thread-safe access with a key optimization: **reads are lock-free**. Writes use fine-grained segment locking. This makes it ideal for read-heavy workloads.

```cpp
#include <folly/concurrency/ConcurrentHashMap.h>

// API mirrors std::unordered_map
folly::ConcurrentHashMap<int64_t, std::string> sessions;

// Thread-safe insert -- no external locking needed
sessions.insert({user_id, session_token});

// Thread-safe lookup -- lock-free read path
auto it = sessions.find(user_id);
if (it != sessions.end()) {
    std::string token = it->second;  // copy while iterator is held
}

// Atomic insert-if-absent (compare-exchange semantics)
auto [iter, inserted] = sessions.insert_or_assign(user_id, new_token);

// Erase
sessions.erase(user_id);

// Iteration is safe but not snapshot-consistent
for (auto& [id, token] : sessions) {
    // Other threads may be modifying the map concurrently
}
```

Compared to `absl::flat_hash_map` + `absl::Mutex`: the Abseil combination has better single-threaded performance but requires all readers to acquire a read lock. `ConcurrentHashMap`'s lock-free reads win under high read concurrency (>8 threads). Go's `sync.Map` is conceptually similar, optimized for the case where entries are written once and read many times.

### folly::MPMCQueue: Multi-Producer Multi-Consumer

`MPMCQueue<T>` is a fixed-capacity lock-free queue for the general multi-producer, multi-consumer case. It is wait-free for producers (writes never block waiting for a lock) and nearly wait-free for consumers.

```cpp
#include <folly/MPMCQueue.h>

// Fixed capacity -- must be specified at construction
folly::MPMCQueue<Task> task_queue(1024);

// Producer thread(s) -- non-blocking write attempt
Task task = make_task();
bool ok = task_queue.write(std::move(task));  // false if queue is full
if (!ok) {
    // Queue full -- apply back-pressure or drop
}

// Blocking write -- waits if full
task_queue.blockingWrite(std::move(task));

// Consumer thread(s)
Task result;
bool got = task_queue.read(result);   // non-blocking -- false if empty
task_queue.blockingRead(result);       // waits if empty

// With timeout
bool success = task_queue.tryReadUntil(
    std::chrono::steady_clock::now() + std::chrono::milliseconds(100),
    result
);
```

Go's buffered channels (`make(chan Task, 1024)`) implement the same semantics. The practical difference: Go channels have a simpler API and are deeply integrated with `select`, while `MPMCQueue` has lower overhead under extreme contention because it uses hardware CAS instructions rather than goroutine scheduling.

### folly::ProducerConsumerQueue: SPSC Ring Buffer

When you have exactly one producer and one consumer, `ProducerConsumerQueue` is the fastest option, it requires no synchronization at all beyond a memory fence.

```cpp
#include <folly/ProducerConsumerQueue.h>

// Fixed capacity -- power of 2 recommended
folly::ProducerConsumerQueue<int> ring_buffer(4096);

// Producer (single thread only!)
bool wrote = ring_buffer.write(value);

// Consumer (single thread only!)
int value;
bool read = ring_buffer.read(value);

// Front-without-pop (peek)
int* front = ring_buffer.frontPtr();
if (front) {
    process(*front);
    ring_buffer.popFront();
}

size_t approx_size = ring_buffer.sizeGuess();  // approximate
```

The Go equivalent is a `chan T` with one goroutine sending and one receiving, but Go channels incur goroutine scheduling overhead even in the hot path. `ProducerConsumerQueue` compiles down to a fetch-and-compare with memory ordering semantics, measurably faster in tight loops.

### Choosing the Right Concurrent Container

Folly's concurrent containers make different trade-offs: `ConcurrentHashMap` favors read-mostly workloads with high concurrency, `AtomicHashMap` trades flexibility for raw speed with a fixed-size table, and the right choice follows from your write rate and key churn.
```
Access Pattern                 → Use
─────────────────────────────────────────────────────────
Single thread, read+write      → absl::flat_hash_map
Multi-thread, rare writes      → folly::ConcurrentHashMap
Multi-thread, frequent writes  → absl::flat_hash_map + absl::Mutex (sharded)
MPMC work queue (general)      → folly::MPMCQueue
SPSC pipeline (fast path)      → folly::ProducerConsumerQueue
Unbounded MPSC / SPSC          → folly::UnboundedQueue (not shown)
```

The mental model is the same as choosing between Go's `map`, `sync.Map`, and channels, match the container to the access pattern rather than reaching for the most general option.

---
