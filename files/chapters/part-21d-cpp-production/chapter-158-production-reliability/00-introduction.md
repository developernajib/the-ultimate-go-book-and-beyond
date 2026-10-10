# Chapter 158: Production Reliability for C++ Services

> "The best code I ever wrote was the runbook that let the on-call engineer go back to sleep.", an SRE at a search company

A C++ service that runs in your laptop's debugger is not the same animal as a C++ service that runs across thirty thousand machines, eight regions, and four continents. The first is a programming problem. The second is a reliability problem, and reliability is what separates a senior engineer from a staff engineer at every FAANG-class company.

This chapter is about the second animal.

## Why Reliability Is the Senior Engineer's Job

Junior engineers ship features. Mid-level engineers ship features that do not break the build. Senior engineers ship features that survive a Black Friday traffic spike, a partial network partition, a kernel upgrade, a noisy neighbor on the same NUMA node, and a junior engineer pushing a config change at 3 AM.

The skill set that gets a candidate hired at Google L5 or Meta E5 is mostly about correctness and design. The skill set that gets them promoted to L6 or E6 is mostly about reliability. Once you are responsible for an oncall rotation, the question is no longer "does this code work?" The question is "what happens when this code does not work, and how fast can we tell?"

That is the question this chapter answers, in the C++ context, with the tools and patterns that real production teams use. No theoretical SRE handbook material. Real coredumps, real symbol servers, real heap profiles, real circuit breakers, real postmortems.

## What Changes at FAANG Scale

A small startup has one prod environment. If it crashes, two engineers see a Slack alert and roll back. Total blast radius: a few thousand users for ten minutes.

A FAANG service has a different shape:

- **Multi-region**. A single line of code runs in `us-east1`, `us-west2`, `europe-west4`, `asia-northeast1`, and a dozen edges. A bad release that lands globally can take down ad serving for an entire continent. Staged rollouts are not a nice-to-have. They are the only thing standing between your code and a 9-figure revenue impact.

- **Blast radius math**. At Google, a typical service ships with a release config that limits any single binary version to no more than 5% of global traffic for the first hour. That number is not arbitrary. It is set so that an undetected regression burns less than the team's monthly error budget.

- **Regression detection at p99.99**. A 5ms latency increase at p50 is invisible. A 5ms regression at p99.99 means a user-visible page-load slowdown for tens of millions of queries per day. Detecting that signal in noise requires statistical machinery that most teams underbuild. We will fix that in chapter 07.

- **Long-tail failures**. At a million queries per second, the one-in-a-million bug fires every second. A subtle memory order bug that ASan does not catch in unit tests will manifest as a one-in-ten-billion crash, which at FAANG scale means several pager events a week.

- **Failures that only exist at scale**. Lock contention that is invisible at 10 RPS becomes a meltdown at 10,000 RPS. A heap fragmentation pattern that is invisible after one hour shows up as RSS bloat after seven days of uptime. You cannot reproduce these in a unit test. You catch them with continuous profiling, canaries, and good observability, or you do not catch them at all.

## Real Postmortem Flavor

Every section of this chapter is grounded in a postmortem that actually happened (with names removed). Examples:

- A C++ ad-serving binary at a top-3 ad network shipped a `std::shared_mutex` change that increased tail latency by 40ms at p99.9. It passed all unit tests and load tests. It failed in production because the read-write lock biased toward writers under sustained read traffic, a property that only manifests with the actual production read/write ratio of 99:1. Detection took six days. The fix took ten minutes. The postmortem ran nineteen pages.

- A C++ search backend at a major engine had a `std::unordered_map` whose hash function was deterministic and adversarially-collidable. A single user-crafted query with 400 colliding keys took the binary's 99th percentile from 8ms to 2.3 seconds. This was not a code bug. It was a reliability bug, and the fix was randomized hash seeding, not a code change in the hot path.

- A C++ database service held a connection pool with a 30-second TCP keepalive. A network appliance upgrade silently cut idle connections at 28 seconds. The result: a 2% error rate that the on-call engineer initially blamed on the database. Three days of debugging later, the answer was a TCP-level keepalive mismatch. Production debugging at this layer is what chapter 19 is about.

These are not stories. These are what an on-call shift looks like when you are responsible for a C++ service that real people depend on.

## Who This Chapter Is For

You are an L5 or L6 engineer at a FAANG-tier company, or you are an SRE on a C++-heavy team, or you are interviewing for a staff role and you know the system-design interview will include a question about how you would reduce the tail latency of a fan-out service. You already know the language. You want the production playbook.

If you are a Go engineer reading this for the C++ angle: most of the patterns transfer (circuit breakers, SLOs, canaries are language-agnostic). The C++-specific parts are the debugging tools, the sanitizers, the symbol servers, the heap profilers, and the absence of a runtime that does the safety work for you.

## How to Read This Chapter

The chapter has 27 sections plus exercises. They are loosely ordered: detection (sanitizers, fuzzing, static analysis), prevention (rollouts, flags, chaos), recovery (circuit breakers, graceful shutdown), debugging (perf, ebpf, postmortems), and operations (SLOs, on-call). You can read it linearly or jump to whichever section matches the fire you are currently fighting.

If you are on-call right now and your pager just went off, jump to chapter 19 for the production debugging tool reference, then chapter 22 for incident command, then come back later for the rest.

---
