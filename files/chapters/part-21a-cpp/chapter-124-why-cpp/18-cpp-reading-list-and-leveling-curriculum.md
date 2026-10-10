## C++ Reading List and Leveling Curriculum

> **Junior to FAANG:** Read three books well, not thirty books shallowly. *Effective Modern C++*, *C++ Concurrency in Action*, and *Computer Systems: A Programmer's Perspective* will get you to L4 if you internalize them.
>
> **Senior at FAANG:** Past L5, you read papers, source code, and post-mortems more than books. The reading list shifts from prescriptive to investigative.

This chapter is the curated path from "I know Go, I want to be a senior C++ engineer at FAANG" to "I can mentor others on this language and ship its hardest projects". It is opinionated. Skip what does not match your domain.

### Books, ordered by where you are

#### Stage 1: Get started (months 1-3)

**A Tour of C++, 3rd edition (Bjarne Stroustrup, 2022).** ~250 pages. The fastest correct introduction. By the language designer. Covers C++20.

**C++ Crash Course (Josh Lospinoso, 2019).** ~700 pages. More verbose alternative if Tour is too dense. Slightly older C++ but well written.

Skip *The C++ Programming Language* (1300 pages, also Stroustrup). It is a reference, not a learning book.

#### Stage 2: Idiomatic modern C++ (months 3-6)

**Effective Modern C++ (Scott Meyers, 2014).** Still the single most useful book on what to *do* in modern C++. 42 items, each with a clear rule and the reasoning behind it. Yes it is from 2014 and stops at C++14, and yes most of it still applies. Read it twice.

**Effective C++ (Scott Meyers, 3rd edition, 2005).** Older. Read items 1-25 for general object-oriented C++ wisdom that has not aged out.

**The C++ Standard Library (Nicolai Josuttis, 2nd edition, 2012).** Comprehensive reference for the STL. Useful as a desk reference.

**C++17/20 The Complete Guide (Nicolai Josuttis, separate volumes).** The deepest treatment of C++17 and C++20 features. Reference-style. Buy the eBook.

#### Stage 3: Concurrency (months 6-9)

**C++ Concurrency in Action, 2nd edition (Anthony Williams, 2019).** The book on the C++ memory model, atomics, threads, futures, and lock-free programming. Williams is the implementer of `std::thread` in libstdc++. Mandatory reading for any serious C++ work in 2026, regardless of domain.

**The Art of Multiprocessor Programming (Herlihy and Shavit, 2nd edition, 2020).** Theory of concurrent data structures. Lock-free, wait-free, transactional memory. Heavy on Java pseudocode. The C++ engineer extracts the principles. Read after C++ Concurrency in Action.

#### Stage 4: Performance and systems (months 9-15)

**Computer Systems: A Programmer's Perspective, 3rd edition (Bryant and O'Hallaron, 2015).** CSAPP. The book on what happens between your C/C++ code and the hardware. Cache hierarchy, virtual memory, system calls, linking, exceptions. Required reading for anyone doing performance work. The CMU course around it (15-213) is online and worth taking.

**Optimized C++ (Kurt Guntheroth, 2016).** Practical performance techniques specific to C++. Less about algorithms, more about idioms that help or hurt the compiler.

**Linkers and Loaders (John Levine, 1999).** Older than most readers but still the only book that explains the entire link process. Object file formats, dynamic linking, relocations. When you debug an ABI mismatch at 2 AM, this book is what saves you.

**Hennessy and Patterson, Computer Architecture: A Quantitative Approach.** For the hardware-curious. Pipelines, branch prediction, memory hierarchy quantitative analysis. Useful for HFT and game engine work.

#### Stage 5: Templates and metaprogramming (months 12-18)

**C++ Templates: The Complete Guide, 2nd edition (Vandevoorde, Josuttis, Gregor, 2017).** The reference on templates. Covers up to C++17. Long, dense, worth it for library authors and senior engineers.

Skip Modern C++ Design (Andrei Alexandrescu, 2001) unless you are interested in historical patterns. It is brilliant but mostly superseded by C++20 concepts.

#### Stage 6: Domain-specific (after 18 months)

Pick what your job demands.

- **Game engines:** *Game Engine Architecture* (Jason Gregory, 3rd edition). *Real-Time Rendering* (Akenine-Möller et al., 4th edition). *Game Programming Patterns* (Robert Nystrom, free online).
- **Graphics:** *Physically Based Rendering* (Pharr, Jakob, Humphreys, 4th edition, free online).
- **Operating systems:** *Operating Systems: Three Easy Pieces* (Arpaci-Dusseau, free online). *Linux Kernel Development* (Robert Love).
- **Compilers:** *Engineering a Compiler* (Cooper and Torczon). LLVM tutorials (online).
- **Databases:** *Database Internals* (Alex Petrov). *Designing Data-Intensive Applications* (Martin Kleppmann).
- **Networking:** *TCP/IP Illustrated, vol 1* (Stevens, Wright). *Computer Networking: A Top-Down Approach* (Kurose, Ross).
- **HFT specific:** *The Microstructure Approach to Exchange Rates* (Lyons). Public talks from Jane Street, Optiver, and CME on internals.
- **Audio:** *Audio Programming Book* (Boulanger, Lazzarini). JUCE tutorials.

### Papers worth your time

Papers age more slowly than books. These are foundational and frequently referenced in interviews and design docs.

**Memory model and concurrency:**
- "Foundations of the C++ Concurrent Memory Model" (Boehm, Adve, 2008).
- "C++ Memory Model" (Boehm, Williams, various WG21 papers).
- "Hazard Pointers: Safe Memory Reclamation for Lock-Free Objects" (Maged Michael, 2004).
- "RCU Usage In the Linux Kernel" (Paul McKenney). Read his perfbook (free online), it is the bible of kernel-level synchronization.
- Herlihy's papers on linearizability and wait-free synchronization.

**Performance and systems:**
- "What Every Programmer Should Know About Memory" (Ulrich Drepper, 2007). Long, slightly dated, still essential.
- "The LMAX Architecture" (Martin Thompson). Origin of the Disruptor.
- "ScyllaDB" papers on shard-per-core and seastar framework.

**C++ language design:**
- WG21 papers themselves. Skim the discussion sections of the proposals you depend on. Reflection (P2996), executors (P2300), contracts (P2900).

### Conference talks

CppCon, Meeting C++, ACCU, C++ on Sea, and CppNorth are the main venues. Talks are on YouTube. Curated must-watches:

- **Sean Parent, "Inheritance Is the Base Class of Evil" (GoingNative 2013).** Foundational.
- **Sean Parent, "Better Code: Runtime Polymorphism" (NDC London 2017).**
- **Chandler Carruth, "Efficiency with Algorithms, Performance with Data Structures" (CppCon 2014).**
- **Chandler Carruth, "Going Nowhere Faster" (CppCon 2015).** On undefined behavior and the optimizer.
- **Carl Cook, "When a Microsecond Is an Eternity" (CppCon 2017).** HFT in C++.
- **Herb Sutter, "Leaks, Lies and Lifetimes" (CppCon 2018).**
- **Herb Sutter, "Software and the Concurrency Revolution" (older).**
- **Andrei Alexandrescu, "Speed Is Found in the Minds of People" (CppCon 2019).** Sorting and pdqsort.
- **Timur Doumler, anything on real-time audio.**
- **Eric Niebler, "A Unifying Abstraction for Async in C++" (CppCon 2021).** Senders and receivers introduction.
- **Jason Turner, C++ Weekly (YouTube channel).** Short focused tips, multiple times per week.
- **CppCast podcast.** Interviews with C++ engineers and committee members.

### Blogs and continuous reading

- **Arthur O'Dwyer (quuxplusone.github.io/blog).** Sharp, opinionated, deeply technical.
- **Jonathan Müller (foonathan.net/blog).** Library design, allocators, modern idioms.
- **Vittorio Romeo (vittorioromeo.com).** Functional patterns, modern C++ idioms.
- **Bartek Filipek (bfilipek.com).** C++ news and walkthroughs.
- **Anthony Williams (justsoftwaresolutions.co.uk).** Concurrency.
- **Cor3ntin (cor3ntin.github.io).** WG21 paper status, sometimes-controversial commentary on C++ direction.
- **Patrice Roy.** Educational, often Quebec-flavored C++ teaching insights.
- **Herb Sutter (herbsutter.com).** Standards committee chair.
- **Marshall Clow (octicons of libcxx).** Library implementer commentary.

For news aggregation: r/cpp on Reddit (the moderators do an excellent weekly digest), isocpp.org/blog, and the C++ Slack.

### Open-source codebases worth reading

Reading good code is the most underrated learning method. Allocate time to it.

- **LLVM and Clang.** Heavy template use, large-scale C++ engineering. Start with `llvm/include/llvm/ADT/` (small algorithms and data structures).
- **Folly (Meta).** Modern utilities. `folly/futures/`, `folly/concurrency/`, `folly/coro/`.
- **Abseil (Google).** `absl::flat_hash_map` and `absl::Status`. The hash map is the reference implementation modern C++ code learns from.
- **Boost.** Older but still influential. `boost::asio` is the ancestor of executors and networking.
- **Chromium.** Massive. Pick a small subsystem (`base/`, `net/socket/`).
- **V8.** JS engine. `src/objects/`, `src/compiler/`.
- **RocksDB.** LSM-tree storage engine. `db/`.
- **ClickHouse.** Modern C++20 columnar database. `src/Functions/` for SIMD examples.
- **simdjson.** High-performance JSON parsing using SIMD.
- **fmt.** The library that became `std::format`. Clean, documented.
- **{fmt} and spdlog.** Logging library on top of fmt.
- **Catch2 and GoogleTest.** Test frameworks. Reading test framework source teaches a lot about macros and template tricks.

### A leveling curriculum from L3 to L7

This is the FAANG-mapped progression for a C++ track engineer. Adapt to your company's ladder.

**L3 (Engineer I, ~0-2 years total experience):**
- Tour of C++, Effective Modern C++ items 1-25, GoogleTest basics.
- Build, debug, and ship a small CLI tool or service in C++ end-to-end.
- Run sanitizers locally. Read your own code's assembly on Godbolt.

**L4 (Engineer II / SWE II, ~2-4 years):**
- All of L3 plus: Effective Modern C++ in full, C++ Concurrency in Action chapters 1-5, CSAPP chapters 5-6 and 9.
- Own a non-trivial subsystem in production. Debug a memory or concurrency bug end-to-end.
- Read 5+ Sean Parent and Chandler Carruth talks.
- Comfortable with CMake, clangd, sanitizers, fuzzers.

**L5 (Senior, ~4-7 years):**
- Templates: C++ Templates: The Complete Guide chapters 1-15.
- Concurrency: C++ Concurrency in Action in full, Herlihy and Shavit chapters 1-9.
- Performance: Optimized C++, perf and VTune fluency.
- Drive a feature from design doc to launch with no senior oversight.
- Mentor L4s on lifetime, ownership, and UB.
- Contribute to a major open-source project or read a comparable amount of code.

**L6 (Staff, ~7-12 years):**
- Standards committee paper-skimming becomes routine.
- Own a multi-team initiative: C++ version migration, ABI policy, sanitizer rollout.
- Read papers on memory model, lock-free algorithms, your domain's research literature.
- Write the design docs that L5s implement. Be the reviewer of last resort on language-edge questions.

**L7 (Senior Staff / Principal, ~12+ years):**
- You are the org-level expert. You decide between rewrites, language additions, hiring profiles.
- Your reading shifts to research papers, post-mortems, vendor architecture documents.
- You mentor L6s on cross-team influence as much as on technical depth.

### What to do this week

Pick one book and one talk. Read the book over the next 6-8 weeks. Watch the talk in 60 minutes.

- This week's talk: Sean Parent, "Inheritance Is the Base Class of Evil" (GoingNative 2013).
- Months 1-2: *A Tour of C++* if new to the language, *Effective Modern C++* if not.

Do not buy a stack of 15 books and feel productive. Read one well, build something with what it taught you, then read the next.

The C++ curriculum is not a sprint. The senior engineers at the top of the field have been at it for 15-25 years and are still learning. The good news: the language rewards depth. Five years in, you will know more about systems than most software engineers ever will.
