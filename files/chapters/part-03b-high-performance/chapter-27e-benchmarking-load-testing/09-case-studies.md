## Case Studies

### Case Study 1: Chaos Engineering + Load Testing

**Problem**: Knowing how a service behaves under load AND under failure. A normal load test measures a healthy system, but the p99 that matters is the one during an incident. Netflix's chaos engineering practice, and its Chaos Monkey tool that terminates instances at random, made the point mainstream: failure is a load condition, and it deserves to be tested like one.

**Solution**: Combine a sustained, coordinated-omission-corrected load with chaos injection.
1. Drive steady, open-model load at the target's rated capacity
2. While under load, terminate a fraction of instances
3. Monitor: does p99 stay inside its budget? How long until recovery?

**Test Infrastructure** (representative shape for this class of testing):
- A dedicated load-generation fleet sized to saturate the target
- HDR histograms recorded against intended send times (see section 3.3)
- Automated SLO evaluation, with the pass/fail thresholds fixed before the run
- Results stored durably and plotted, so runs are comparable over time

**The failure mode this catches**, and the arithmetic worth internalizing: suppose requests to a dead instance block for the full 5-second timeout before failing over. Little's Law (L = λW) says the number of requests piled up in flight is arrival rate times wait time, so a single dead instance taking 1,000 RPS accumulates 1,000 x 5s = **5,000 concurrent stuck requests**. Each one is holding a goroutine, a connection, and its share of a bounded pool. Nothing here is subtle once you see it: the pool is exhausted long before the 5 seconds elapse, and requests bound for the *healthy* instances now block waiting for a connection. That is the cascade. The dead instance did not take down the service, the timeout budget did.

The lesson generalizes past this example. Timeouts and pool sizes are coupled, and Little's Law tells you how: any timeout W with arrival rate λ needs a pool that can absorb λW, or a failure turns into an outage. A load test against healthy instances will never show you this. That is why the chaos run exists.

### Case Study 2: Continuous Benchmark Regression Systems

**Infrastructure**: The Go team runs continuous benchmarking over the compiler and standard library (the public dashboard lives at perf.golang.org), and mature Go shops copy the shape: every commit or nightly build runs the benchmark suite, results land in a database, and `benchstat`-style statistical analysis compares each run against a trailing window.

**Alert criteria that work in practice**:
- Latency increase beyond noise (require statistical significance, not a raw threshold)
- Allocation-rate increase > 10%
- Throughput decrease beyond the trailing window's variance

**What such systems catch**: reflect-related slowdowns in serialization paths, GC pause regressions from allocator changes, and the occasional false positive that only statistics (not eyeballs) can distinguish from noise.

### Case Study 3: Traffic Replay for a TLS-Terminating Proxy

**Challenge**: A TLS-terminating proxy handles a request mix that synthetic uniform load does not resemble: real URL distributions are heavily skewed, connection reuse varies, and handshake cost dominates for new clients. A flat load test measures a workload nobody has.

**Approach** (the replay pattern, which is the transferable part):
- Capture a representative window of production traffic from sampled logs
- Replay it against a staging instance with a custom Go replayer, preserving relative arrival timing rather than firing as fast as possible
- Fit the key distribution to the captured logs instead of assuming one (see section 6.4)
- Record p50 through p99.99 against intended send times

**The class of bug this finds**: periodic, low-frequency stalls that only appear in the very high percentiles. Anything on a timer, TLS session ticket rotation, certificate reload, cache expiry, log rotation, metrics flush, will stall a small fraction of requests. That fraction is invisible at p99 and can be glaring at p99.99, which is precisely why the replay is run long enough to sample it. The usual fix is not to make the periodic work faster but to stagger it, so that workers do not all pause in lockstep.

**Why no numbers here**: the tempting version of this case study names a company, quotes a p99.99 of 2.5 s, and pins it on a 2-second pause every 10 minutes. Treat any such number you cannot reproduce as decoration. What transfers between systems is the *shape* (periodic work produces tail stalls, and staggering fixes it) and the *method* (replay real traffic, measure the high 9s, run long enough to catch a slow period). The magnitudes belong to somebody else's hardware.

### Case Study 4: Benchmark-as-guard for shared platform libraries

**Problem**: A platform team maintains foundational libraries that hundreds of services depend on (metrics, tracing, config, HTTP client). This is the highest-value code in the company in both directions: a regression in a logging library does not slow one service, it slows the fleet, and it arrives disguised as an innocuous dependency bump in someone else's PR. The gate has to sit at the library's release, because by the time it reaches a service nobody is looking for it.

**Approach**: every platform library carries a `go test -bench` suite over its hot paths with production-representative inputs. CI runs it on every PR against a pinned baseline. The runners are the point: dedicated hardware, CPU pinning, turbo disabled, nothing else scheduled. As section 1.3 demonstrated, a shared runner will hand you `p=0.004` on unchanged code, so a gate without a quiet machine underneath it is a random number generator that blocks deploys. Results go to a time-series store and get plotted, because the six-month trend catches the slow drift that no single PR delta ever exceeds.

**The thresholds are the hard part**, and they are a local decision rather than a number to copy. Set them from your own runners' measured noise floor (see section 4.3): the gate must sit above what your hardware produces on identical code, or the team will learn to rubber-stamp it within a month. Gate allocations separately and tightly, since `allocs/op` is deterministic and needs no noise allowance at all.

**Result pattern**: regressions get attributed to the PR that caused them, while the author still remembers the code, instead of surfacing a quarter later as an unexplained fleet-wide latency creep. A caught regression is either fixed or explicitly accepted in writing before merge.

**Lesson**: platform-level benchmark governance is a high-value investment, and the concrete benefit is organizational rather than technical. A few quiet hosts and a CI policy protect hundreds of services. Individual service teams cannot each replicate this rigor, and asking them to is the wrong design. The platform team owns it once, for everyone.

### Cross-case patterns

Four case studies, four transferable shapes. First, every successful benchmarking practice is automated. Manual benchmarks catch nothing, because they are not run consistently. Second, every successful load test corrects for coordinated omission. A team reporting p99 from `ab` or classic `wrk` is reporting a number about its load generator. Third, every successful program combines benchmarks (fast, targeted, in CI) with load tests (slow, representative, in staging). Neither alone is sufficient. Fourth, every one has organizational buy-in: the engineers running the benchmarks can block a release. Without that authority, benchmarks become advisory and the signal decays.

A fifth shape is worth stating because it cuts against how case studies are usually read. Notice how few numbers survived in the four above. The magnitudes in a case study, someone else's p99, someone else's threshold, someone else's speedup, are the least portable thing in it, because they encode hardware, traffic, and a code base you do not have. What transfers is the mechanism (periodic work makes tail stalls, timeouts times arrival rate sizes your pool) and the method (quiet runners, intended send times, statistics over single runs). When you read a performance case study, including this one, take the shape and re-measure the numbers.

### Senior @ FAANG: your team's internal case study

Take each service your team owns and write its internal load-testing case study, updated quarterly. Include: the traffic shape you load test against and how it matches production. The scenarios you run and their cadence. The recent regressions caught and shipped. The recent false positives and how the threshold was adjusted. The infrastructure cost and the estimated savings from caught incidents. Share with leadership as evidence of the investment paying off. This document converts benchmarking from an engineering ritual into a business-legible story that sustains the investment across budget cycles and organizational changes. Services whose teams write this document keep their benchmarks funded. Services whose teams do not tend to see the practice quietly dissolve under budget pressure, and the consequences appear two years later as a cascade of avoidable incidents.

---
