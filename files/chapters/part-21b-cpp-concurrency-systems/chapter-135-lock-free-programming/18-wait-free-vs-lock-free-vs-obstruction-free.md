## Wait-Free vs Lock-Free vs Obstruction-Free

Maurice Herlihy formalized the progress hierarchy in his 1991 paper "Wait-Free Synchronization" (TOPLAS). Three classes of nonblocking algorithms exist, ordered by strength.

### Formal Definitions

**Wait-free.** Every operation completes in a bounded number of its own steps, regardless of what other threads do. A failing or slow thread cannot prevent another thread from making progress within a bounded time. Strongest guarantee.

**Lock-free.** At least one thread makes progress in a bounded number of total steps across all threads. Individual threads can starve, but the system as a whole always advances.

**Obstruction-free.** A thread executing in isolation (with all other threads paused) completes in a bounded number of steps. Concurrent threads can livelock each other indefinitely.

These definitions have a strict hierarchy: wait-free implies lock-free, lock-free implies obstruction-free. The reverse implications do not hold.

### What Each Class Buys You

Wait-free guarantees per-thread latency bounds. Required in hard real-time systems (avionics, automotive ECUs, audio DSP), where a single missed deadline is a system failure.

Lock-free guarantees system-wide throughput under contention. Standard for high-performance servers, kernels, and databases. A starving thread is a tail-latency problem but not a correctness problem.

Obstruction-free is the weakest useful class. Sun's Hybrid Transactional Memory (HyTM) used obstruction-free as the baseline because it admits simpler algorithms and relies on a contention manager to schedule retries.

### Why Wait-Free Is Rare

Most "lock-free" data structures in production are not wait-free. Treiber stack, MSQueue, Harris-Fraser skip list, all are lock-free but not wait-free. A persistently unlucky thread can fail its CAS forever while others succeed.

Wait-free algorithms generally require helping. Each thread, when starting an operation, announces it in a public location. Threads that observe an in-progress operation help complete it before starting their own. This guarantees that a slow thread is dragged forward by faster threads.

Helping doubles or triples the work per operation in the common case. The amortized cost is high, which is why wait-free is rarely the right choice when lock-free suffices.

### Universal Construction

Herlihy's 1991 paper proved a startling result: any sequential object can be transformed into a wait-free concurrent object using only consensus primitives (CAS or LL/SC). The construction is straightforward. State is represented as a linked list of operation records. Each record describes one operation. To apply an operation, a thread appends a record to the list with CAS. The "current state" is the result of replaying all records in order.

```cpp
template <typename SeqObj, typename Op>
class UniversalWaitFreeObject {
    struct Cell {
        Op op;
        std::atomic<Cell*> next{nullptr};
        SeqObj state;
        std::atomic<bool> completed{false};
    };
    std::atomic<Cell*> tail_;
    std::atomic<Cell*> announce_[kMaxThreads];

public:
    auto apply(int tid, Op op) {
        Cell* mine = new Cell{op};
        announce_[tid].store(mine, std::memory_order_release);
        for (int round = 0; round < 2 * kMaxThreads; ++round) {
            help_pending();
            if (mine->completed.load(std::memory_order_acquire)) {
                return mine->state;
            }
        }
        // Help self
        attach(mine);
        return mine->state;
    }
};
```

The construction is wait-free because every thread is helped by every other thread within a bounded number of rounds. It is also wildly impractical: every operation does O(P) work where P is the thread count.

Production "wait-free" structures use targeted helping rather than universal construction, paying a smaller helping tax.

### Wait-Free Queue (Kogan-Petrank 2011)

The Kogan-Petrank queue is the canonical practical wait-free FIFO. It is an MSQueue augmented with an announcement array: each thread publishes its current operation, and threads help each other by completing announced operations they observe.

```cpp
template <typename T>
class WaitFreeQueue {
    struct Node {
        T value;
        std::atomic<Node*> next{nullptr};
        std::atomic<int> enq_tid{-1};  // thread that enqueued
        std::atomic<int> deq_tid{-1};  // thread that dequeued
    };

    struct OpDesc {
        long phase;
        bool pending;
        bool enqueue;
        Node* node;
    };

    std::atomic<Node*> head_;
    std::atomic<Node*> tail_;
    std::atomic<OpDesc*> state_[kMaxThreads];

    long max_phase() {
        long m = 0;
        for (int i = 0; i < kMaxThreads; ++i) {
            OpDesc* d = state_[i].load(std::memory_order_acquire);
            if (d && d->pending && d->phase > m) m = d->phase;
        }
        return m;
    }

    void help(long phase) {
        for (int i = 0; i < kMaxThreads; ++i) {
            OpDesc* d = state_[i].load(std::memory_order_acquire);
            if (d && d->pending && d->phase <= phase) {
                if (d->enqueue) help_enq(i, phase);
                else help_deq(i, phase);
            }
        }
    }
};
```

Each operation announces a phase. Threads help any operation with a phase no greater than their own. After helping, a thread proceeds with its own operation, which is now guaranteed to complete within bounded steps because no slow thread can hold up the queue.

Kogan-Petrank's amortized cost per operation is O(P) where P is the contending thread count. In the common case (low contention), most help loops find no pending operations and exit cheaply.

The full implementation runs around 600 lines and is documented in the paper "Wait-free queues with multiple enqueuers and dequeuers" (PPoPP 2011). Production systems rarely deploy it because the constant factors are 3-5x higher than MSQueue, and only systems with hard latency bounds (HFT, avionics) need the per-thread guarantee.

### Helping Mechanisms

Three helping patterns exist.

**Operation announcement.** The thread announces its operation in a public slot. Helpers complete it. Used in Kogan-Petrank.

**State recording.** The thread, before each step, records the next step it intends to take. Helpers can replay the recorded steps. Used in Herlihy's universal construction.

**Cooperative cleanup.** Threads that observe partially-completed operations finish them as a side effect of their own work. Used in MSQueue (the lagging tail fix), Harris's marked pointers, Click's cooperative resize. This is the lightest form of helping but only ensures lock-freedom, not wait-freedom.

The third pattern is what most "lock-free" algorithms use. The first two are required for wait-freedom but expensive enough to limit adoption.

### Senior at FAANG: When Wait-Free Is Mandatory

Real-time audio processing pipelines need wait-freedom on the audio thread. A 48 kHz stream has 20.8 microseconds per sample. Any blocking, any starvation, any priority inversion causes a click or dropout.

The audio thread's contract: never call malloc, never take a mutex, never make a blocking syscall, never perform an unbounded operation. The standard pattern is SPSC ring buffers between the audio thread and worker threads, where the audio thread only does wait-free pushes and pulls.

```cpp
class AudioCallback {
    SPSCRing<MidiEvent, 1024> midi_in_;
    SPSCRing<float, 8192>     audio_out_;

    void process(float* output, int frames) {
        MidiEvent ev;
        while (midi_in_.pop(ev)) handle_midi(ev);
        for (int i = 0; i < frames; ++i) output[i] = next_sample();
    }
};
```

The SPSC ring is wait-free for both producer and consumer. Each push is at most 4-5 instructions: read tail, read cached head, store value, release-store tail. There is no loop, no retry, no helping.

Avionics flight control loops at 80-200 Hz operate similarly. Lockstep redundant computers exchange state through wait-free shared memory regions, never through any algorithm with unbounded retry.

### Obstruction-Free in Practice

Software Transactional Memory (STM) systems are typically obstruction-free. Two transactions touching the same locations may abort each other indefinitely. A contention manager (separate from the core algorithm) decides which transaction to back off and which to allow.

```cpp
class ObstructionFreeCounter {
    std::atomic<long> value_;

    long increment() {
        long old, fresh;
        do {
            old = value_.load(std::memory_order_acquire);
            fresh = old + 1;
        } while (!value_.compare_exchange_weak(old, fresh,
                    std::memory_order_acq_rel));
        return fresh;
    }
};
```

This counter is actually lock-free, not just obstruction-free, because the failed thread's CAS is observed by the winning thread as the winning step. A pure obstruction-free CAS counter does not exist (CAS always implies lock-free progress).

A real obstruction-free algorithm: lock-free transactional memory with no helping. Two transactions writing to the same address abort and retry. Without a contention manager, livelock is possible. Throughput depends entirely on the manager's quality.

### The Hierarchy in Code

```cpp
// Wait-free: bounded steps regardless of contention
int wait_free_increment(int tid, std::atomic<int> announces[]) {
    announces[tid].fetch_add(1, std::memory_order_release);
    int sum = 0;
    for (int i = 0; i < kMaxThreads; ++i)
        sum += announces[i].load(std::memory_order_acquire);
    return sum;  // bounded by kMaxThreads loads
}

// Lock-free: at least one thread makes progress
int lock_free_increment(std::atomic<int>& v) {
    int old = v.load(std::memory_order_acquire);
    while (!v.compare_exchange_weak(old, old + 1,
        std::memory_order_acq_rel));  // unbounded for any individual thread
    return old + 1;
}

// Obstruction-free: alone in isolation, can livelock with peers
class STMTxn {
    bool commit(...) {
        if (!validate_read_set()) return false;  // abort, no helping
        write_back();
        return true;
    }
};
```

### Junior to FAANG: Atomic Is Not Lock-Free

`std::atomic<T>::is_lock_free()` returns true if the implementation uses CPU atomics rather than a hidden mutex. This is a much weaker statement than "the algorithm using this atomic is lock-free". A spin loop on a `std::atomic<int>` flag is not lock-free as an algorithm because the spinning thread's progress is bounded by the holder's progress, exactly like a mutex.

The class of an algorithm depends on the algorithm, not the primitives. CAS is necessary but not sufficient for lock-freedom.

### Practical Recommendation

Default to lock-free. Reach for wait-free only when latency bounds make it mandatory and the helping overhead is acceptable. Avoid obstruction-free unless you are building an STM and have an explicit contention management strategy.

For interviews, knowing the formal definitions and the universal construction proof is the L5 bar. Implementing Kogan-Petrank from memory is L6+ territory.
