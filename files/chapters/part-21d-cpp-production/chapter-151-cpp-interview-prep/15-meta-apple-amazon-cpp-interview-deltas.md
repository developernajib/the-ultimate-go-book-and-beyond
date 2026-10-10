## Meta, Apple, Amazon, Netflix, Citadel C++ Interview Deltas

Each FAANG-tier (and adjacent HFT) employer has a distinct interview style for C++ engineers. Preparing for "FAANG interviews" as one bucket is a mistake. The same candidate can pass at Meta and fail at Apple because the rubrics are tuned differently. This file maps the deltas: what to prep specifically for each, what the cultural signal is, and what the C++ codebase looks like once you are in.

### Meta (Facebook)

Meta's flagship C++ projects: PyTorch (the C++ core), RocksDB, Folly, Wangle, Proxygen, HHVM. Heavy investment in storage, ML systems, and high-throughput networked services.

#### What's different from Google

- Coding round: more emphasis on speed. Two problems in 35 minutes is common, vs Google's one problem in 45.
- Less focus on Modern C++ idioms specifically. Many Meta interviewers grade in pseudocode style, clean Python-flavored C++ is fine.
- System design at E5+ is heavy on storage internals. RocksDB-style LSM, Cassandra-style replication, distributed consensus.
- Behavioral round is "Life Story" plus "Jedi" (managing conflict). Less rubric-y than Google.

#### What to prep

- RocksDB internals: LSM tree, compaction strategies (leveled vs universal), write amplification, block cache.
- PyTorch C++ if you target AI Infra: tensor representation, TorchScript, custom autograd.
- Distributed systems at scale: shard management, leader election, replication lag.
- Two coding problems in 35 minutes. Practice the speed.

#### Levels

E4 (entry senior), E5 (senior), E6 (staff), E7 (senior staff), E8 (principal). E5 maps roughly to Google L5. E6 to L6.

#### Cultural signal

"Move fast." Meta interviewers reward bias for action. A candidate who delays decisions or asks for more information loses points. A candidate who states an assumption and proceeds, ready to revisit, scores well.

### Apple

Apple's C++ shows up in WebKit (Safari, JavaScriptCore), CoreFoundation, the OS frameworks, the Metal/MoltenVK stack, the silicon firmware tooling. C++ is heavier in lower-level OS and driver work. Higher layers use Swift and Objective-C.

#### What's different from Google

- Interview focus on ownership semantics, RAII, and memory management. Reference counting (the WebKit `Ref<T>`, `RefPtr<T>` types) shows up.
- Less algorithmic LeetCode, more "implement this real component cleanly". Cache, allocator, thread-safe container.
- System design centered on a specific product domain. WebKit team will ask layout/rendering. Audio team will ask DSP pipelines. Apple Silicon team will ask SoC bring-up.
- Confidentiality is heavy. Interviewers cannot say what team they are on. You apply to "the C++ pool" and get matched.

#### What to prep

- WebKit internals if targeting WebKit: layout tree, render tree, JavaScript bindings, GC integration.
- Memory management deeply. Why `unique_ptr` over `shared_ptr`, when each is correct, custom ref-counting. C++17 / C++20 features that affect ownership.
- Performance under battery and thermal constraints. Apple cares about energy. A candidate who discusses cache miss costs and DVFS is differentiated.
- Be ready for low-level questions: how does virtual function dispatch work, what is the size of a class with these members, how does TLS work.

#### Levels

ICT2 (senior), ICT3 (staff), ICT4 (senior staff), ICT5 (principal). The leveling is conservative. ICT3 at Apple is often comparable in scope to L6 at Google or E6 at Meta.

#### Cultural signal

"Quality over speed." Apple interviewers reward thoroughness. A candidate who says "let me handle the edge case where the buffer is null" before being prompted scores well. A candidate who optimizes for impressing with cleverness loses points.

### Amazon

Amazon's C++ is concentrated in Nitro (AWS hypervisor and EC2 silicon offload), the Lustre filesystem service, Kindle firmware, parts of Alexa, and the trading-adjacent compute services. C++ at Amazon is more domain-specific than at Meta or Google.

#### What's different from Google

- Leadership Principles dominate behavioral. There are 16 LPs. You will be asked about at least 6 across the loop, often 2 LPs per round.
- The bar raiser. One interviewer per loop is a "bar raiser" from outside the hiring team. They are rubric-strict and have a veto.
- Coding rounds use OO design more than Google. "Design and implement a parking lot" with classes, inheritance, and a clean interface is common.
- System design is workload-driven. Less "design Twitter" and more "design the pricing service that handles 50k QPS with strict latency".

#### What to prep

- The 16 Leadership Principles. Memorize them. Have a STAR story for each one. Two stories for the customer-obsession LP (it is asked twice).
- "Tell me about a time you disagreed with your manager and were proven right." Have an answer.
- "Tell me about a time you missed a deadline." Have an answer that owns the failure.
- Object-oriented design: SOLID, design patterns (Strategy, Factory, Observer), UML in your head.
- AWS services: S3, EC2, DynamoDB, Lambda, SQS, Kinesis. You should be able to name what each does and a use case.

#### Levels

L4 (SDE I, new grad), L5 (SDE II), L6 (Senior SDE), L7 (Principal), L8 (Senior Principal). L6 at Amazon is comparable to Google L5 in scope. L7 at Amazon is comparable to Google L6.

#### Cultural signal

"Customer obsession" and "Frugality." Mention a specific customer outcome in every project story. Mention cost trade-offs in design answers. A candidate who proposes the most expensive solution without justification loses points.

### Netflix

Netflix's C++ is in the codec stack (the Netflix Encoding Pipeline, codec research, perceptual quality models), the DRM stack, parts of the streaming infrastructure. The company is small (relatively, ~13k employees) and the bar is exceptionally high.

#### What's different from Google

- Loop is shorter (4 to 5 rounds vs Google's 5 to 6). Each round is dense.
- Few "stand-alone IC" interviews. Most rounds expect both technical depth and judgment.
- Codec roles ask deep questions on H.264/H.265/AV1 internals. Frame types, motion estimation, rate-distortion optimization.
- Behavioral interviews emphasize "context not control": can you operate without detailed direction, with high judgment, on hard problems?

#### What to prep

- Video codec basics if targeting media: I/P/B frames, GOP structure, Discrete Cosine Transform, quantization, entropy coding.
- VMAF (Netflix's perceptual quality metric) and how it is computed.
- Adaptive bitrate streaming: HLS, DASH, manifest design, ABR algorithms.
- High judgment behavioral stories: "tell me about a time you decided not to do something the team wanted to do, and why."

#### Levels

Netflix has a flat leveling structure. Most ICs are "Senior Software Engineer". A few are "Staff" or "Principal". The pay is high, the leveling is intentionally flat.

#### Cultural signal

"High performance, high autonomy." Netflix interviewers reward independent judgment. A candidate who waits for direction loses points. A candidate who proposes a path and defends it scores well.

### Citadel and Jane Street (HFT)

Citadel, Jane Street, Hudson River Trading, Optiver, Two Sigma. Quantitative finance and high-frequency trading. C++ is the dominant language for the order books, exchange connectivity, market data parsing, and risk engines.

#### What's different from Google

- Latency is everything. p99.9 latency in microseconds, not milliseconds. p50 in single-digit microseconds.
- Templates, constexpr, manual memory layout. Cache-line awareness. Branch prediction. NUMA pinning. Lockless ring buffers.
- Coding rounds use compilers and runtime tools. You write code, compile it, run it, often on the firm's actual benchmark harness.
- Math and probability are real. A 30-minute brain teaser round on probability and combinatorics is normal at Jane Street. Citadel asks dynamic programming with a finance flavor.

#### What to prep

- Cache: line size, alignment, false sharing, prefetching, the cost of an L1 vs L2 vs L3 vs RAM hit.
- Lock-free programming: atomics, memory orders, ring buffers, single-producer single-consumer queues.
- Templates and constexpr deeply. CRTP, expression templates, `if constexpr` for compile-time branching.
- Network: kernel bypass (DPDK, Solarflare onload, ef_vi), TCP vs multicast, exchange protocol parsing (FIX, ITCH, OUCH).
- Probability: birthday paradox, expected value puzzles, optimal stopping problems. The Heard on the Street book.

#### Cultural signal

"Excellence and intellectual rigor." HFT interviewers reward depth and precision. A candidate who knows the difference between `std::memory_order_acquire` and `std::memory_order_consume` and can explain why `consume` is effectively unused scores well. A candidate who hand-waves about "atomics" loses.

#### Compensation

HFT total comp is typically 1.5x to 3x FAANG at the same level. Bonuses are large. Equity is uncommon (private companies). Hours are longer but vary by firm.

### Cross-Reference Cheat Sheet

| Skill | Google | Meta | Apple | Amazon | Netflix | Citadel |
|-------|--------|------|-------|--------|---------|---------|
| LeetCode speed | Medium | High | Low | Medium | Medium | Medium |
| Modern C++ idioms | High | Medium | High | Medium | Medium | Highest |
| System design at scale | High | High | Medium (product-specific) | High | Medium | Low (focus is hot path) |
| OO design | Medium | Medium | High | Highest | Medium | Low |
| Memory management depth | Medium | Medium | Highest | Medium | Medium | Highest |
| Distributed systems | Highest | Highest | Low | Highest | High | Low |
| Domain knowledge weight | Low to medium | Low | Highest | Medium | Highest | Highest |
| Behavioral structure | STAR + GnL | Life story | Light | 16 LPs, formulaic | High judgment | Light |

### How to Adapt Your Prep

If you have 6 weeks, allocate:

- 2 weeks: core C++ depth (memory, concurrency, templates, modern features). Same content for every shop.
- 2 weeks: algorithm and data structure speed runs. Same content for every shop.
- 1 week: system design fundamentals. Generic for Google/Meta/Amazon. Domain-specific for Apple/Netflix/Citadel.
- 1 week: shop-specific. Read the company's tech blog, study their published systems, prepare behavioral stories matching their cultural keywords.

Do not interview at all six in the same month. The cognitive context-switch costs accuracy. Pick two or three that fit your goals, prepare deeply for each, and be honest about the others.

### Senior at FAANG: Pick on Fit, Not Prestige

The companies have different cultures, different work styles, different on-call expectations. Apple's deep-product focus is great for someone who wants to ship a polished thing. Meta's velocity is great for someone who likes shipping experiments. Citadel pays the most but the work is narrow. Google's scope is broadest but the bureaucracy is real. Pick on fit. Prestige fades after the first month. The work and the team are what you live with.
