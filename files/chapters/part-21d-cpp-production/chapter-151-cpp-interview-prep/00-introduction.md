# Chapter 151: C++ Interview Preparation

> "An interview is not a test of what you know, it's a test of how you think.", Unknown

C++ interviews at FAANG are among the most demanding technical interviews in the industry. Unlike interviews for most other languages, a C++ interview does not just test whether you know the syntax. It tests your mental model of the machine: how memory is laid out, how the object model works under the hood, how the compiler reasons about your code, and how threads interact at the hardware level. A candidate who can recite the STL API but cannot explain what happens to an object when it crosses a function boundary will not pass a senior C++ interview at Google or Meta.

This chapter is the complete preparation guide. It covers every category of question you will encounter in a FAANG C++ interview and gives you the depth of answer expected at the senior and staff engineer level.

## What This Chapter Covers

The chapter is organized into sixteen technical sections plus exercises and summary:

**Core Language Questions**, The 25 questions that appear most frequently across every company. Undefined behavior, the Rule of Five, rvalue references, virtual dispatch, constexpr, ADL, structured bindings. Every answer here needs to go deeper than a textbook definition: the interviewer wants to know that you understand the *why*.

**Memory Management Questions**, Twenty questions focused on the heap, stack, smart pointers, allocators, and memory safety tools. Go engineers coming to C++ have the steepest learning curve here, because Go's garbage collector removes an entire class of thinking that C++ demands be explicit.

**Concurrency and Threading Questions**, Twenty questions on `std::mutex`, atomics, the C++ memory model, lock-free programming, condition variables, and C++20 concurrency primitives. These questions separate candidates who have written concurrent C++ from those who have only read about it.

**Template Metaprogramming Questions**, Fifteen questions on templates, SFINAE, concepts, CRTP, and fold expressions. Templates are C++'s most expressive feature and also its most commonly misunderstood. Interviewers use these questions to find engineers who can maintain and extend template-heavy codebases.

**OOD Problems**, Five complete object-oriented design problems with full C++ implementations: Parking Lot, LRU Cache, Elevator System, Chess Game, and File System. These are the canonical interview problems for system design at the class level.

**System Design with C++ Focus**, Five system design problems where the C++ implementation details matter: LFU Cache, Lock-Free MPSC Queue, Memory Allocator, Timer Wheel, and Zero-Copy HTTP Parser.

**LeetCode in C++**, Twenty essential algorithm problems with idiomatic C++ solutions, complexity analysis, and notes on C++-specific techniques (using `nth_element` instead of sorting, monotonic deques, two-heap medians).

**Company-Specific Expectations**, What Google, Meta, Apple, Microsoft, and Amazon each expect from a C++ hire. Each company has its own internal C++ dialect, build system, and coding standards.

**C++ vs Go**, How to answer the inevitable "why C++?" and "why not Go?" questions in a way that demonstrates genuine expertise in both languages.

**Production Debugging War Stories**, Incident postmortems, ABI silent corruption, coordinated omission in latency percentiles, and subtle memory races that senior interviewers probe.

**Google L4 / L5 / L6 Rubrics & Coding Rounds**, Engineering levels, hiring rubrics, code readability standards, and coding loop simulation.

**Google System Design & Leadership**, Distributed C++ design expectations, high-cardinality time-series engines, and Googliness behavioural interviews.

**Meta, Apple, Amazon, and Quant/HFT Deltas**, Specific interview deltas across FAANG and top quantitative trading firms (Citadel, Jane Street, Jump).

**Mock Interview Loop**, A complete 60-minute mock interview script with question progressions, evaluation scorecards, and candidate-interviewer dialogue.

## How to Use This Chapter

If you are preparing for an interview in two weeks, read all sections in order. The core language and memory sections are the highest-return investment, they underlie every other category.

If you are preparing for a specific company, read the company-specific section first, then focus on the OOD and system design sections, which receive the most interview time at FAANG.

If you are a Go engineer and this is your first C++ interview, pay special attention to the memory management section and the concurrency section. The mental model shift from GC-managed memory to manual memory is the single biggest gap, and interviewers can detect it immediately in how you talk about pointers and ownership.

## The Standard You Are Being Held To

At Google, the bar for a C++ hire at L5 (Senior) is: the candidate should be able to contribute to any C++ codebase within two weeks. That means reading unfamiliar template code, debugging memory corruption with AddressSanitizer, understanding the performance implications of a cache miss, and designing a class hierarchy that other engineers can safely extend.

At Meta, the bar is similar but with an additional emphasis on concurrency: can this engineer reason about lock-free data structures and the C++ memory model well enough to review concurrent code in Folly?

This chapter prepares you to meet both bars.

---
