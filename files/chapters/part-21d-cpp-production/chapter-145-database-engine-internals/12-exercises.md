## Exercises

### Exercise 1: LRU-K Buffer Pool

Extend the `BufferPoolManager` from section 04 with the following changes:

- Add a `stats()` method that returns the total number of page hits (found in pool) and misses (fetched from disk) since construction.
- Add a `prefetch_sequential(page_id_t start, int count)` method that pre-loads `count` consecutive pages starting at `start` into the buffer pool without pinning them. This simulates read-ahead for sequential scans.
- Verify that `UnpinPage` called on a page with `pin_count == 0` returns `false` rather than underflowing to a negative pin count.
- Write a test that simulates sequential flooding: fill the pool with 100 unique pages, then scan pages 200-299 sequentially. Verify that after the scan, the original hot pages (1-10 accessed repeatedly) are not evicted if LRU-K with K=2 is working correctly.

Hint: pages accessed only once during the scan have `backward_k_distance = +∞` and should be evicted before pages with two accesses.

---

### Exercise 2: Bloom Filter Integration in the KV Store

The `KVStore` in section 08 does not persist bloom filters across restarts, after `load()` rebuilds them from disk, the in-memory state is correct but the SST file's bloom filter bytes are used only on the first load.

Extend the implementation:

1. When `KVStore` starts, discover all `sst-*.dat` files in the directory and call `sst->load()` on each, ordered by file modification time (newest first).
2. Add a `stats()` method that returns the number of bloom filter hits (key found in SST) and bloom filter saves (key skipped due to bloom filter saying "definitely not here"). Track these counters across all `get()` calls.
3. Compute and print the actual false positive rate of your bloom filter: `false_positives / bloom_saves`.

To test: insert 10,000 keys, flush, then call `get()` for 10,000 keys that were never inserted. The bloom filter should skip the SST search for approximately 99% of those misses (given 10 bits-per-key).

---

### Exercise 3: 2PL Deadlock Detection

Using the `DeadlockDetector` from section 06:

1. Create a scenario with four transactions: T1 holds lock on row A and waits for row B. T2 holds lock on row B and waits for row C. T3 holds lock on row C and waits for row A. Verify that `detect_deadlock()` returns a non-zero transaction ID.
2. After the victim transaction is identified and removed from the waits-for graph, verify that `detect_deadlock()` returns 0 (no more cycles).
3. Implement a `LockManager` class with a `SharedLock` and `ExclusiveLock` method. When a transaction cannot acquire a lock immediately, it registers a waits-for edge and calls `detect_deadlock()`. If a cycle is detected, the current transaction is aborted rather than the victim (wound-wait protocol: older transactions wound, force abort, younger transactions).

Expected behavior: T1 (older) tries to acquire a lock held by T2 (younger). T1 wounds T2: T2 is aborted, T1 proceeds.

---

### Exercise 4: Range Scan over a Skip List

Using the `SkipList` from section 07:

1. Insert the following (key, value) pairs: (1, "a"), (3, "c"), (5, "e"), (7, "g"), (9, "i"), (2, "b"), (4, "d"), (6, "f"), (8, "h"), (10, "j").
2. Call `range_scan(3, 7)` and verify the result is exactly: `[(3,"c"), (4,"d"), (5,"e"), (6,"f"), (7,"g")]` in that order.
3. Delete key 5. Call `range_scan(3, 7)` again and verify key 5 is absent.
4. Measure the time to do 1,000,000 `find()` calls on a skip list of 100,000 entries and compare it to the same lookup pattern on a `std::map` of the same size. The skip list should be within 2-3× of `std::map` for random lookups. For sequential iteration, the skip list's `next_leaf` chain should outperform `std::map::iterator` due to better cache locality.

---

### Exercise 5: WAL Recovery

Using the `WAL` from section 03:

1. Write a scenario where three transactions are in progress: T1 commits, T2 crashes mid-flight (no COMMIT record), T3 commits. Write their WAL records to a file, then call `recover()` and verify that only the operations of T1 and T3 are applied to a `std::map<std::string, std::string>` test store.
2. Extend `WALRecord` to include an `undo_key` field: when an UPDATE is logged, also record the old value so it can be undone. Implement the UNDO phase in `recover()`: after the REDO phase, walk the WAL backwards and for each uncommitted transaction, apply the undo operation (restore old value or re-delete).
3. Simulate a crash during UNDO: the WAL file is truncated mid-undo-pass. Verify that recovery correctly handles the partial undo by checking the CLR (Compensation Log Record) mechanism: write a CLR record for each undo step so that a second recovery pass skips already-undone work.

Expected outcome: idempotent recovery, calling `recover()` twice on the same WAL produces the same final state.

---
