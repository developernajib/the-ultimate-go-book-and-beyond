# Chapter 90H: Software Failures That Killed - When Code Costs Lives

*"Software is eating the world. And sometimes, the world chokes."* - Marc Andreessen (adapted)

Software has moved far beyond the screen. It controls the radiation beams that treat cancer patients, the flight
control surfaces that keep 200-ton aircraft aloft, the missile defense systems that protect soldiers in combat
zones, and the autonomous vehicles that share roads with pedestrians. When software in these domains fails, the
consequences are not a 500 error or a lost shopping cart - they are coffins, funerals, and congressional hearings.
The incidents in this chapter are not hypothetical worst-case scenarios. They happened. Real people died because of
race conditions, integer overflows, floating-point rounding errors, single points of failure, and management
decisions to ship software that engineers knew was not ready. Every one of these failures was preventable with
engineering practices that were well-understood at the time they occurred.

This chapter is different from the previous chapter on production incidents. Chapter 90G covered infrastructure
failures - outages, data loss, cascading failures in distributed systems. The incidents here crossed a threshold
that no amount of SLA credits or customer apology emails can address: they caused physical harm or death. The
Therac-25 radiation therapy machine killed patients because a race condition bypassed safety interlocks. The Boeing
737 MAX crashed twice, killing 346 people, because software was designed to mask a hardware deficiency using a
single sensor with no redundancy. Toyota vehicles accelerated uncontrollably because spaghetti code with 11,000
global variables made the software untestable and unprovable. A Patriot missile battery failed to intercept an
incoming Scud because floating-point rounding errors accumulated over 100 hours of continuous operation, killing 28
American soldiers. An Uber self-driving car killed a pedestrian because the software could not classify a person
walking outside a crosswalk. The Ariane 5 rocket self-destructed because a 64-bit to 16-bit conversion overflowed
and the backup computer was an identical clone running the same flawed code. The Mars Climate Orbiter burned up
because one team used pounds-force and another used newtons. The 2003 Northeast Blackout left 50 million people
without power because a race condition silenced the alarm system. Volkswagen programmed defeat devices that
deliberately cheated emissions tests for a decade. Boeing's Starliner spacecraft launched with a timer that was 11
hours off because nobody ran an end-to-end integration test. Each of these incidents carries lessons that every
software engineer building safety-critical or high-consequence systems must internalize.

For each incident, we reconstruct the complete timeline from the first warning signs through the catastrophic
failure and its aftermath. We perform a deep technical root cause analysis, examining the specific code-level
defects, the architectural decisions that made those defects possible, and the organizational failures that allowed
flawed software to reach production. We then examine the company's reaction - the cover-ups, the blame-shifting,
the regulatory responses, and the eventual resolution. Finally, and most importantly, we build Go code that
demonstrates the correct engineering pattern for each failure mode. Go's type system, concurrency model, and
standard library provide powerful tools for preventing many of these failure categories, and we demonstrate exactly
how. The goal is not morbid fascination with disaster - it is to build an unshakeable conviction that software
quality in safety-critical systems is a moral obligation, not a business trade-off.

**What you will learn in this chapter:**

- How race conditions in the Therac-25 radiation machine bypassed safety interlocks and delivered lethal radiation
  doses, and how to build mutex-based safety interlock systems in Go that make unsafe states unrepresentable
- Why Boeing's MCAS system relied on a single angle-of-attack sensor with no redundancy, how software was used to
  mask a fundamental hardware design flaw, and how to implement redundant sensor voting systems in Go
- How Toyota's 11,000 global variables and spaghetti code architecture made the software untestable and created
  conditions for unintended acceleration, and why Go's design philosophy prevents many of these problems
- Why floating-point arithmetic killed 28 soldiers when a Patriot missile battery's clock drifted 0.34 seconds
  over 100 hours, and how to use Go's monotonic clock to prevent time-drift vulnerabilities
- How Uber's self-driving car could not classify a pedestrian outside a crosswalk, the organizational decision to
  disable emergency braking, and lessons for AI safety systems
- Why the Ariane 5 rocket destroyed itself because of a 64-bit to 16-bit integer overflow with an identical
  backup, and how to implement safe type conversions in Go
- How a units mismatch between pounds-force and newtons destroyed the Mars Climate Orbiter, and how to build
  type-safe unit systems in Go that make unit confusion a compile-time error
- Why a race condition in the alarm system caused the largest blackout in North American history, and how to build
  concurrent alarm processing systems in Go with proper synchronization
- How Volkswagen systematically programmed defeat devices to cheat emissions tests, the engineering ethics
  implications, and what software engineers should do when asked to write unethical code
- Why Boeing Starliner launched with a timer 11 hours off because nobody ran end-to-end tests, and why integration
  testing is non-negotiable for safety-critical systems

**Why this matters for every engineer:**

You may never write code for a radiation therapy machine or a flight control system. But the patterns that killed
people in these incidents - race conditions, single points of failure, integer overflows, floating-point errors,
inadequate testing, silenced alarms, and management pressure to ship - exist in every codebase. The Therac-25 race
condition is the same class of bug that causes data corruption in your web application's concurrent request handler.
The Boeing single-sensor design is the same architectural flaw as a service with a single database and no failover.
The Toyota spaghetti code is the same technical debt that makes your legacy service impossible to refactor safely.
Learning from these incidents does not just make you a better safety-critical systems engineer - it makes you a
better engineer, period.

**Prerequisites:** Chapters 84--90G (Senior Engineer Mindset & Incident Analysis), Chapters 17--22 (Concurrency, Channels & Synchronization), Chapter 27C (Go Runtime Internals), and Chapter 58 (Distributed Systems Patterns).

---

### Junior → FAANG: Why Engineers Study Fatality-Class Failures

Studying failures that caused deaths is not a morbid exercise: it is the most direct route to internalizing why engineering discipline matters. FAANG interviews occasionally use incidents from this chapter as behavioral anchors. "Tell me about a time you pushed back on shipping a feature you believed was not ready" maps directly to the decisions made by engineers at Boeing and Toyota who knew the software had critical defects and shipped it anyway. Your answer to that question should reference the principle, not the incident. The incidents ground your conviction. When you say "I pushed back because a single point of failure in the sensor input with no fallback is the same class of defect that caused the Boeing 737 MAX crashes," you demonstrate that your safety instincts are connected to engineering history, not just intuition. That framing distinguishes senior engineers from junior engineers in behavioral screens.

### Senior @ FAANG: Safety-Critical Patterns as a Baseline for Any High-Stakes System

At L6, the incidents in this chapter are not cautionary tales about specialized domains. They are the baseline for any system where failure causes harm at scale: financial systems where a bug triggers incorrect trades, healthcare infrastructure where a misconfiguration affects patient routing, infrastructure control planes where a deployment takes down a revenue-critical service. The engineering practices that would have prevented Therac-25 (mutex-guarded safety interlocks), Boeing 737 MAX (redundant sensor voting), and Patriot (monotonic time with overflow detection) are the same practices that prevent your distributed system from entering an unsafe state under concurrent load. At staff level, you use this chapter to define the non-negotiable engineering standards for any system your org classifies as tier-0 or safety-critical: formal safety analysis, redundancy at every single point of failure, end-to-end integration testing before any production promotion, and an explicit process for engineers to raise safety concerns without retaliation. The organizational failure mode in every incident in this chapter is that engineers who knew the software was not safe were overridden by management decisions to ship. Building a culture where safety concerns propagate to decision-makers and are resolved before shipping is a staff engineer's organizational contribution, not a management responsibility.

