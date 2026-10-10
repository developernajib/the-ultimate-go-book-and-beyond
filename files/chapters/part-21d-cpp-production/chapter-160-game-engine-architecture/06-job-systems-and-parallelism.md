## Job Systems and Parallelism

Eight cores and a 16.6 ms deadline mean you have 133 core-milliseconds per frame and no way to use them from one thread. How engines spread work is the difference between a 60 fps title and a 20 fps one.

### Why Not a Thread Pool With a Mutex

The obvious design is a queue guarded by a mutex and N workers pulling from it. It fails at frame granularity for reasons of scale.

Engine jobs are small. Culling 10,000 objects splits into 100 jobs of 100 objects each, and each job might run for 20 microseconds. With one mutex-guarded queue, every one of those 100 jobs contends with 7 other threads on the same cache line. The lock's cost, plus the cache-line ping-pong of the queue head, plus the futex syscall when a worker sleeps, can exceed the job's actual work.

Thread-per-subsystem (a render thread, a physics thread, an audio thread) is the older design and it fails differently: it does not balance. Physics has nothing to do this frame and its core idles while the render thread is the critical path. You cannot fix that by adding cores.

### Work Stealing

The design every modern engine converged on: each worker owns a **double-ended queue**. It pushes and pops its own jobs from one end, requiring no synchronization in the common case, and when it runs dry it steals from another worker's opposite end.

```cpp
// One deque per worker. Owner uses the bottom, thieves use the top,
// so the fast path never touches a contended cache line.
class WorkStealingDeque {
public:
    // Owner only. No lock.
    void push(Job* j) {
        int64_t b = bottom_.load(std::memory_order_relaxed);
        jobs_[b & kMask] = j;
        std::atomic_thread_fence(std::memory_order_release);
        bottom_.store(b + 1, std::memory_order_relaxed);
    }

    // Owner only.
    Job* pop() {
        int64_t b = bottom_.load(std::memory_order_relaxed) - 1;
        bottom_.store(b, std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_seq_cst);
        int64_t t = top_.load(std::memory_order_relaxed);
        if (t > b) { bottom_.store(b + 1, std::memory_order_relaxed); return nullptr; }
        Job* j = jobs_[b & kMask];
        if (t != b) return j;              // not the last one, no race
        // Last job: race with a thief for it.
        if (!top_.compare_exchange_strong(t, t + 1,
                std::memory_order_seq_cst, std::memory_order_relaxed))
            j = nullptr;                    // thief won
        bottom_.store(b + 1, std::memory_order_relaxed);
        return j;
    }

    // Thieves only.
    Job* steal() {
        int64_t t = top_.load(std::memory_order_acquire);
        std::atomic_thread_fence(std::memory_order_seq_cst);
        int64_t b = bottom_.load(std::memory_order_acquire);
        if (t >= b) return nullptr;         // empty
        Job* j = jobs_[t & kMask];
        if (!top_.compare_exchange_strong(t, t + 1,
                std::memory_order_seq_cst, std::memory_order_relaxed))
            return nullptr;                 // lost the race, caller retries
        return j;
    }

private:
    static constexpr int64_t kMask = 4095;
    std::atomic<int64_t> top_{0}, bottom_{0};
    Job* jobs_[kMask + 1];
};
```

The properties that make this work:

- **The owner's fast path is uncontended.** Push and pop touch `bottom_` only, and no other thread writes it except in the one-job-left race. In the steady state a worker running its own jobs performs zero contended operations.
- **Thieves take from the other end**, so `top_` and `bottom_` are usually different cache lines and the owner and thieves do not ping-pong. Production implementations pad them apart explicitly.
- **Only the last job races**, resolved by one CAS.
- **Stealing is self-balancing** with no scheduler and no central queue. Idle workers find work - busy workers are never interrupted.

This is subtle lock-free code and the memory ordering above is load-bearing, which is why Chapter 135 is a prerequisite rather than a suggestion. The honest engineering advice is to use a proven implementation rather than write your own.

### Parallel For

The API on top is almost always a parallel-for that splits a range into jobs and waits:

```cpp
// Split into chunks large enough that job overhead is amortized.
// Too small and scheduling dominates - too large and you cannot balance.
template <typename F>
void parallelFor(size_t count, size_t grainSize, F&& fn) {
    JobCounter counter;
    for (size_t begin = 0; begin < count; begin += grainSize) {
        size_t end = std::min(begin + grainSize, count);
        scheduler.submit(&counter, [=] { fn(begin, end); });
    }
    scheduler.waitFor(&counter);   // help run jobs while waiting
}
```

Two details matter more than they look. **Grain size** is a real tuning knob: too small and per-job overhead dominates, too large and one long chunk becomes the critical path with cores idle. Engines tune it per call site with a profiler.

**`waitFor` runs jobs while waiting** rather than blocking. A worker that blocks is a core doing nothing, so instead it pulls more work from its own deque. This is what keeps utilization high, and it is the detail naive job systems miss.

### What Cannot Be Parallelized

Being able to name these is the senior half of the topic.

**Anything touching the graphics API on a single-threaded device.** Modern APIs (Chapter 161) allow multithreaded command recording, but submission usually funnels through one thread.

**Order-dependent gameplay.** If entity A's update reads B's post-update state, they are serialized by data dependency. This is why ECS's declared component signatures matter: they make the dependency explicit so the scheduler can prove what is safe.

**Anything with a mutex on the hot path.** Adding threads to lock-contended code makes it slower. If a job takes a lock, that lock is your scalability limit and no job system fixes it.

### Junior to FAANG: Why Stealing Beats a Queue

"Why not one queue with a mutex?"

Because engine jobs are ~20 microseconds and there are hundreds per frame, so lock contention and the cache-line ping-pong on the queue head cost a meaningful fraction of the job itself, across 8 threads hammering one line. Work stealing gives each worker a private deque, so the common path is uncontended - only an idle worker touches anyone else's queue, and only then does it pay for an atomic.

The second half: it load-balances for free. No scheduler decides who does what, idle workers just take work. Compare to thread-per-subsystem, which cannot balance at all because physics's idle core cannot help the render thread.

### Senior at FAANG: The Frame Graph

Once you have a job system, the frame becomes a dependency graph rather than a sequence, and that is the actual architecture.

Culling depends on transforms. Render submission depends on culling. Animation depends on gameplay. Audio depends on transforms. Everything else is concurrent. Engines that make this graph explicit, declaring each system's reads and writes, get three things: automatic parallelism (the scheduler runs anything non-conflicting), a computable critical path (the longest chain is your frame's floor, and no number of cores helps below it), and race-freedom by construction.

The critical path is the number to manage. If gameplay → animation → physics → culling → submit is 12 ms of serial dependency, your frame cannot go below 12 ms on any hardware, and the optimization worth funding is breaking that chain, not making each stage faster. Teams that profile per-system cost without ever computing the critical path optimize the wrong things for years.

The review question this gives you: when someone adds a system, what did it add to the critical path? A cheap system on the critical path is worse than an expensive one off it, and that is not visible in a flat profile.
