## C++ Job Market and FAANG Roles

> **Junior to FAANG:** C++ roles at FAANG are not a different ladder, they are the same SWE ladder with a domain filter. You still need to clear LeetCode and system design. The C++ part shows up in code review and on-the-job, not in the interview gate.
>
> **Senior at FAANG:** C++ specialists hit a higher ceiling in HFT and infra than in product. If you want compensation outliers, look at trading firms. If you want career range, FAANG infra is broader.

This chapter is opinionated and based on public compensation data (levels.fyi as of late 2025), public job postings, conference attendance lists (CppCon, Meeting C++), and the open-source contribution patterns of major projects. Numbers shift quarter to quarter. The shape of the market does not.

### Where C++ roles live at the major companies

#### Google / Alphabet

C++ is one of Google's three primary languages (with Java and Go, plus Python for ML and tooling). The codebase is huge.

- **Search infrastructure:** indexing, ranking, serving. C++ for the hot path, mixed languages in the orchestration layer.
- **Chrome and Chrome OS:** ~35M lines of C++. Probably the largest C++ engineering org outside of game studios. Hires aggressively at L4-L6.
- **V8:** the JavaScript engine. C++ all the way down, with TurboFan and Maglev compilers as the hottest sub-projects.
- **Android Runtime (ART):** C++ runtime for Android. The Java/Kotlin code runs on this.
- **Borg/Kubernetes-adjacent infra:** Borg core is C++. Kubernetes (the open-source spinoff) is Go. Internally, lots of C++ persists in the infra layer.
- **YouTube media stack:** transcoders, codecs, streaming. C++ with hand-tuned SIMD.
- **TensorFlow core, JAX XLA:** C++ tensor and compiler infrastructure under the Python API.
- **gRPC, Abseil, Protobuf:** open-source projects led by Google, all C++.

L4 (SWE II) C++ comp at Google is in the same band as any other L4 SWE. levels.fyi median around \$230-280K total in the US. L5 (Senior) \$370-450K. L6 (Staff) \$550-700K. L7 (Senior Staff) \$750K-1M+. C++ specialists in V8 or Chrome at L6+ skew to the top of the band because the talent pool is small.

#### Meta

C++ is heavily used at Meta despite the company's reputation as a Hack/Python/JavaScript shop.

- **PyTorch core:** C++ backend, ATen, autograd, distributed. Python is the API.
- **Folly:** Meta's open-source C++ utility library. Source of much modern C++ wisdom.
- **HHVM:** Hack/PHP runtime. C++.
- **RocksDB:** the embedded LSM key-value store powering MyRocks, CockroachDB, TiKV. C++.
- **Mercury:** Meta's RPC framework. C++.
- **Infrastructure (Tupperware, Twine, Service Router):** much of it C++.
- **Reality Labs (VR/AR):** rendering, tracking, lens distortion correction. C++ with heavy SIMD.

E4 base around \$200K, total comp \$300-400K. E5 around \$500K. E6 (Staff) \$700K+. PyTorch L6/L7 engineers are at the high end. Reality Labs has hardware-engineering-style comp expectations and is typically slightly lower than core infra.

#### Apple

Apple is more C++ than people realize.

- **WebKit:** the web engine behind Safari and every iOS browser (until very recently the only allowed engine on iOS). C++ throughout.
- **Core OS, kernel, IOKit, DriverKit:** mostly C and C++, with Swift being added carefully at higher layers.
- **Swift compiler and standard library:** Swift the *language* is implemented in C++. The compiler is one of the largest active C++ projects.
- **Metal, GPU drivers, Core Graphics, Core Animation:** C++.
- **Audio Units, Logic Pro DSP, Final Cut codec stack:** C++.
- **CoreML inference:** Swift API, C++ engine.

Apple comp is competitive but historically slightly behind Google and Meta at equivalent levels. ICT4 around \$300-400K total, ICT5 \$500-650K, ICT6 \$700K-1M. Apple ICT6 (Staff equivalent) is hard to reach. The hardware-software co-design teams (Silicon, GPU) often pay above the public bands.

#### Amazon

Amazon's reputation is Java-heavy, and that is true at the application layer. C++ shows up in:

- **AWS C++ SDK:** small but non-trivial team.
- **EC2 Nitro:** firmware and hypervisor work. C++ and C.
- **Lustre, FSx file systems:** C++.
- **DynamoDB, Aurora, S3 internals:** C++ in the hot path of some services, Java in others. S3's storage nodes have significant C++.
- **Kindle and Fire TV firmware:** C++.
- **Annapurna Labs (Graviton, Nitro chips):** mixed C/C++ with Verilog.

Amazon levels do not map 1:1 to other FAANGs. L5 (SDE II) is roughly Google L4. L6 (SDE III) maps to Google L5. L7 (Principal) is rarer and more selective. Comp is generally lower in base, with stock vesting backloaded. L6 total comp around \$400-500K. L7 \$700K+.

#### Netflix

Smaller engineering org, narrower C++ footprint, but where it exists it is heavily compensated.

- **Codec optimization (AV1, VP9, HEVC):** C++ with hand-tuned SIMD.
- **Real-time encoder ladder:** C++.
- **Open Connect (CDN appliances):** FreeBSD-based, C and C++.

Netflix is famous for paying market top-of-band in cash. Senior engineers in Encoding are well-paid, often \$700K-1M. The trade-off is no equity-bonanza upside and a culture that aggressively prunes performance.

#### Other top C++ employers

- **NVIDIA:** CUDA, cuDNN, TensorRT, GPU compilers, driver stack. C++ everywhere. Comp surged with the GPU boom: senior engineers in compiler or driver teams have been seeing \$600K-1M+ total comp at SSW-level.
- **AMD:** ROCm, HIP, GPU drivers. Below NVIDIA on comp, similar work shape.
- **Microsoft:** Windows kernel (C), Office (C++), Visual C++ compiler (C++), DirectX, MSVC STL. Lower TC than west-coast FAANG but better work-life and stable.

### High-frequency trading and quant

This is the alternative ladder for senior C++ engineers, and the comp ceiling is dramatically higher than FAANG for the very top tier.

- **Citadel and Citadel Securities:** heavy C++ shops. Senior engineer total comp regularly \$700K-1.5M, principal levels \$2M+.
- **Jane Street:** primarily OCaml, but the latency-critical paths are C++. Senior comp \$600K-1.5M.
- **Hudson River Trading (HRT):** C++ heavy. Comp similar to Citadel.
- **Jump Trading, Two Sigma, DRW, IMC, Optiver, Tower Research, Headlands, XTX:** all heavy C++.

The trade-off: smaller scope per engineer (you own a strategy or a venue, not "Search"), less brand recognition outside finance, and a culture that is more demanding on hours and intensity than most FAANG teams. Bonuses are heavily P&L-linked. A bad year cuts comp meaningfully. A great year can double it.

Interview process is similar to FAANG (algorithms, system design) plus deep C++ knowledge questions and often a probability/puzzles round. They actually expect you to know C++ at the interview, unlike FAANG which often does not test it.

### Game studios

Lower comp than FAANG and HFT, but real C++ work and clear career paths.

- **Engine teams (Unreal, Unity native, Frostbite, RE Engine, id Tech):** \$200-400K senior comp.
- **Console manufacturers (Sony, Nintendo, Microsoft Xbox):** similar.
- **Roblox, Epic, Riot:** trending higher, \$300-500K senior.

### Realistic FAANG C++ pipeline

The interview process is the same as for any SWE role, with these caveats:

1. **Coding rounds.** Almost always allow C++ but typically also allow Python. Most candidates pick the language they LeetCode in. If you pick C++, do not waste time writing your own iterator boilerplate. Use `std::vector`, `std::unordered_map`, `std::sort`, `auto`. Interviewers care about correct algorithms first, idiomatic code second.

2. **System design.** Language-agnostic at L4-L5. At L6+, expect to discuss memory layout, latency budgets, and trade-offs that show C++ fluency.

3. **Domain rounds (specific to C++ teams).** Chrome, V8, PyTorch, Folly, ART, Swift compiler. These teams add a dedicated C++ deep dive. Topics: move semantics, lifetimes, undefined behavior, templates, concurrency primitives, the memory model, ABI implications. If you fail this round, you will be redirected to a non-C++ team rather than rejected outright.

4. **Behavioral and "Googleyness/Apple Cultural Fit/Meta Bar Raiser".** Same as any other role.

The point: do not assume the C++ team has lower coding round bar because the language is harder. The bar is the same. The C++ knowledge is bonus.

### What separates L5 from L6 in C++

Anecdotal but consistent across companies:

- **L4 (SWE II):** writes correct C++ with reasonable idioms, follows the team style guide, debugs basic memory issues with sanitizers.
- **L5 (Senior):** designs sub-systems, reasons about ownership and lifetime in design docs, identifies UB before it ships, runs fuzzing and code coverage on their components.
- **L6 (Staff):** sets the C++ standard for an org, decides on the C++ version migration plan, owns ABI compatibility for shipping libraries, mentors L4-L5 on advanced template and lifetime issues, makes call on whether to adopt Rust at the boundary.
- **L7 (Senior Staff):** owns the long-term direction of a multi-team codebase, represents the company at WG21 or similar, sets cross-org engineering policy.

C++ specialists tend to over-index on technical depth and under-index on cross-team influence. The path to L6+ requires both. If you want to ride C++ as long as possible without hitting a ceiling, HFT is more forgiving of "deep specialist with narrow scope" patterns than FAANG.
