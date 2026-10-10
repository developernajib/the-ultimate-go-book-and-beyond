## Interview Questions

### Q1: Why is absl::flat_hash_map faster than std::unordered_map? When would you choose the opposite?

**Answer:**

`std::unordered_map` uses a node-based design: each key-value pair is a separate heap allocation, and the hash table stores pointers to those nodes. Every lookup requires two memory dereferences, one to the table bucket, one to the node. In a large map, both dereferences cause cache misses.

`absl::flat_hash_map` uses open addressing with inline storage. Keys and values are stored directly in the table array. The table also stores 1-byte "control bytes" (high bits of the hash) in a separate parallel array. A SIMD instruction can check 16 control bytes simultaneously, finding candidate slots in one CPU instruction without touching the key-value data at all.

Benchmark difference: 30-40% faster for typical workloads, with the gap widening as the map grows beyond L2 cache.

**When to prefer std::unordered_map or absl::node_hash_map:**
- When you store raw pointers or iterators to map values that must remain stable across insertions. `flat_hash_map` may relocate elements on rehash, invalidating those pointers. `node_hash_map` preserves pointer stability while still using Abseil's hash infrastructure.

### Q2: Google uses absl::Status instead of C++ exceptions. What are the trade-offs?

**Answer:**

**absl::Status advantages:**
- Explicit: callers cannot forget to check errors (linters enforce this)
- Predictable control flow: no hidden exit paths through the call stack
- Composable: `RETURN_IF_ERROR` and `ASSIGN_OR_RETURN` make propagation concise
- Works across language boundaries: `absl::Status` maps directly to gRPC status codes, HTTP status codes, and can be serialized to protobuf
- No overhead on the non-error path (unlike exceptions, which require stack unwinding infrastructure)

**Exception advantages:**
- Less verbose in deeply nested call stacks without the macro boilerplate
- Existing C++ libraries (STL, Boost) use exceptions for error reporting
- RAII works naturally, destructors run on any exit path

**The Google rationale:** At Google's scale, large codebases with many contributors, exception propagation is hard to reason about statically. `absl::Status` makes error handling explicit and auditable. The trade-off is verbosity at each call site, offset by the macros.

Go engineers will recognize this exactly: Go made the same choice, with `if err != nil` as the explicit propagation mechanism. The `RETURN_IF_ERROR` macro is Go's implicit return on error, operationalized in C++.

### Q3: How does folly::Future differ from std::future? When does the difference matter?

**Answer:**

`std::future<T>` has three fundamental limitations:
1. **No continuations:** You cannot attach `.then()` to a `std::future`. You must call `.get()`, which blocks the current thread.
2. **No executor control:** When you call `.get()` on a `std::async` future, continuation runs on an unspecified thread.
3. **No composition:** There is no standard `when_all()` or `when_any()` over multiple `std::future` objects.

`folly::Future<T>` addresses all three:
- `.thenValue()` / `.thenError()` attach continuations that run without blocking
- `.via(executor)` specifies exactly which thread pool continuation code runs on
- `folly::collectAll()` and `folly::collectAny()` compose multiple futures

**When it matters:** Any async pipeline with more than one stage. The canonical example is a request handler that (1) validates input, (2) fetches from a database, (3) formats a response. With `std::future`, step 2 blocks a thread while the database responds. With `folly::Future` and an I/O executor, the thread is returned to the pool during the I/O wait.

### Q4: Explain the LSM tree architecture. Why does RocksDB use it instead of a B-tree?

**Answer:**

A B-tree performs **random writes**: inserting a key at position N in a sorted tree may require modifying a node anywhere on disk. On HDDs this is slow (seek time). On SSDs, random writes cause write amplification and uneven cell wear.

An LSM tree converts **all writes to sequential I/O**:
1. Write goes to an in-memory `MemTable` (sorted skiplist) and a sequential WAL for durability
2. When `MemTable` fills, it is flushed as an immutable SST file, one large sequential write
3. Background compaction merges SST files across levels, also producing sequential writes

The trade-off: writes are fast, reads must check multiple levels. Bloom filters (probabilistic data structures) eliminate >95% of unnecessary SST file checks, keeping point reads fast. Range scans are still slower than B-trees because data is scattered across levels.

**When to choose RocksDB over a B-tree (like SQLite or LMDB):**
- Write-heavy workloads (>50% writes)
- SSD storage (B-trees on SSDs are less disadvantaged, but LSM still wins for write-heavy)
- Need for online compaction and configurable compression per level

### Q5: How does folly::IOBuf achieve zero-copy I/O? What does "zero-copy" actually mean here?

**Answer:**

"Zero-copy" means the application never copies data between user-space buffers. In a naive implementation:
1. Network stack delivers data into kernel buffer
2. `recv()` copies kernel buffer → application buffer A
3. Application processes and forwards the data: copies buffer A → buffer B
4. `send()` copies buffer B → kernel send buffer

With `IOBuf` and scatter/gather I/O:
1. Network stack delivers data to a kernel buffer pointed to by an `IOBuf`
2. Application reads directly from the `IOBuf`, no copy step 2
3. To prepend a header, `prependChain()` links a new `IOBuf` without copying the body
4. `sendmsg()` with multiple `iovec` entries sends the chain directly, kernel reads from multiple buffers in one syscall

The key mechanism: `IOBuf` chains allow building a logical message from physically separate buffers. The scatter/gather `sendmsg` syscall accepts multiple `iovec` entries, so the kernel reads the header and body buffers directly without the application merging them.

In practice, "zero-copy" eliminates the application-level copies. The kernel still copies to NIC DMA memory, but that path can also be eliminated with RDMA or kernel bypass (DPDK), which `IOBuf`'s design is compatible with.

### Q6: When would you use gRPC's async API over the sync API in C++?

**Answer:**

The sync gRPC API (blocking stubs) ties up one thread per in-flight RPC. Under 10k concurrent RPCs, you need 10k OS threads, which is not feasible.

The async API uses a `CompletionQueue`: you initiate RPCs without blocking, then poll the `CompletionQueue` for completions. A small thread pool (4-16 threads) can multiplex thousands of concurrent RPCs.

**Use sync when:**
- RPC concurrency is low (<100 concurrent calls)
- Code simplicity matters more than throughput
- You're writing a command-line tool or batch processor

**Use async when:**
- High concurrency (>1000 concurrent RPCs)
- You're building a proxy or gateway that fans out to many backends
- Latency matters and you cannot afford thread context switching

Go avoids this entirely: the Go gRPC runtime uses goroutines, which are cheap. The generated Go stubs are always "sync-looking" (blocking calls), but the goroutine scheduler provides the async multiplexing automatically. This is one of the clearest cases where Go's concurrency model is architecturally simpler than C++.

### Q7: What is protobuf Arena allocation and when should you use it?

**Answer:**

By default, every protobuf message, nested message, and repeated field element is individually heap-allocated. In a service processing 100k RPS, parsing one request message may trigger 50 small allocations, each going to `malloc` with its associated bookkeeping overhead and heap fragmentation.

Arena allocation consolidates all these allocations into a single pre-allocated block:

```cpp
google::protobuf::Arena arena;
auto* request = Arena::CreateMessage<api::Request>(&arena);
request->ParseFromArray(data, size);
// All nested messages within `request` also allocate from `arena`
// When `arena` is destroyed, all objects are freed in one operation
```

**When to use arenas:**
- High-throughput request parsing (>10k RPS)
- Messages with many nested sub-messages or repeated fields
- Per-request processing where all messages share the same lifetime

**When not to use arenas:**
- When messages have different lifetimes within the same scope
- When messages need to escape the current request scope

Measured impact at Google: arena allocation reduces protobuf parsing overhead by 2-3x in message-heavy code paths, primarily by eliminating individual `malloc`/`free` calls and improving allocator cache behavior.

### Q8: What are Boost.MultiIndex's advantages over maintaining separate std::map and std::unordered_map?

**Answer:**

With separate containers, you must keep them synchronized manually:
```cpp
// Insert: must update both containers atomically
std::map<int, Employee>         by_id;
std::unordered_map<std::string, Employee*> by_name;

// Insert -- if by_name insert throws after by_id insert, they are inconsistent
auto [it, ok] = by_id.emplace(emp.id, emp);
by_name.emplace(emp.name, &it->second);  // pointer instability on std::map rehash? No -- std::map is node-based
```

Problems:
1. **Consistency:** Every mutation must update all containers atomically. In concurrent code, this requires holding a lock across all updates or using complex transactional logic.
2. **Memory:** Each container stores a copy of the data (or pointers + overhead).
3. **Modification:** Changing a field that is indexed requires removing and re-inserting in all affected containers.

`Boost.MultiIndex` provides:
1. **Atomic consistency:** All indices are updated in a single operation. There is no intermediate state where one index is updated and another is not.
2. **Single storage:** The element is stored once. Indices hold internal pointers.
3. **Safe modification:** The `modify()` function updates the element and rebuilds all affected indices atomically, rolling back if the modification violates a uniqueness constraint.

The performance cost is slightly higher per-operation overhead (updating all indices), but the correctness guarantees are worth it for any non-trivial use case.

### Q9: How do Boost.Asio strands prevent data races without mutexes?

**Answer:**

A strand is a serialization guarantee: handlers dispatched through the same strand are **never executed concurrently**, even in a multi-threaded `io_context`. Two different threads can run two different strand handlers, but not two handlers of the same strand simultaneously.

Without strands, in a thread pool of 4 threads all running the same `io_context`, a `TcpSession`'s read handler and write handler could run concurrently. Both access `socket_` and the session's buffers, a data race.

With `asio::strand`, the io_context guarantees that if thread A is running handler H1 of a strand, thread B will not run any other handler of the same strand until H1 completes. Thread B may run handlers of a *different* strand concurrently.

This is conceptually similar to a mutex, but implemented without actual mutex acquisition, the io_context's scheduler tracks which strands have handlers in-flight and delays dispatch. The result is zero lock contention while maintaining correctness, which is why strands are the idiomatic Asio tool rather than `std::mutex`.

Go's model is simpler: each goroutine is sequential, and you protect shared state with channels or mutexes explicitly. Strands are an implicit serialization mechanism that Asio provides because C++ callbacks lack Go's structured concurrency model.

---
