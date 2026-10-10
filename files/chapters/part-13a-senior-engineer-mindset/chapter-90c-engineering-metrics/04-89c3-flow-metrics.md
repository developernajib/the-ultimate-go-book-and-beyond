## 90C.3 Flow Metrics

### What Flow Metrics Measure

DORA metrics measure your deployment pipeline. Flow metrics, popularized by Dr. Mik Kersten in "Project to Product" (2018), measure your entire value stream - from when work is identified to when it reaches the customer. Flow metrics give you visibility into where work gets stuck before it even enters your deployment pipeline.

### Little's Law

Flow metrics are grounded in queueing theory, specifically Little's Law:

```
L = λW

L = average number of items in the system (Work in Progress / WIP)
λ = average throughput (Flow Velocity - items completed per unit time)
W = average time an item spends in the system (Flow Time)

Rearranged:
Flow Time = WIP / Flow Velocity
```

This law has a profound practical implication: **the single most effective way to reduce flow time (how long work takes) is to reduce WIP (the number of things in flight simultaneously)**. Adding engineers to an overloaded system often increases WIP and thus increases flow time. This is the mathematical basis for WIP limits.

### The Four Flow Metrics

**Flow Time**: The elapsed time from when a feature/story/task is started to when it is deployed to production. This is the customer-facing equivalent of lead time - it includes planning time, waiting in queues, development time, review time, and deployment time.

**Flow Velocity**: The number of flow items (features, bugs, technical debt items, risks) completed per time period. This is your throughput - how much value you are delivering.

**Flow Efficiency**: The ratio of active work time to total flow time.

```
Flow Efficiency = (Active Time / Total Flow Time) × 100%

Example:
- Feature A took 10 days from start to production
- Engineers actually worked on it for 2 days
- Flow Efficiency = (2/10) × 100% = 20%
```

Industry average flow efficiency is 15-20%. Elite teams achieve 40-60%. The remaining time is "wait time" - waiting for reviews, waiting for meetings, waiting for dependencies, waiting for deployment windows.

**Flow Load**: The total WIP in your value stream. Per Little's Law, as flow load increases beyond the team's sustainable capacity, flow time increases nonlinearly - a phenomenon known as "queue explosion."

### Cycle Time vs. Lead Time

These terms are often confused:

```
        ┌─────────────────────────────────────────────┐
        │                  Lead Time                  │  
        │                                             │  
  Work  │   Backlog   Development   Review   Deploy   │  Production
Identified │              ↑                              │
        │            Cycle Time                       │ 
        └─────────────────────────────────────────────┘
```

- **Lead time**: Total time from request to delivery (customer perspective)
- **Cycle time**: Time from when work actively begins to when it is done (team perspective)

For most teams, lead time >>> cycle time because work spends most of its time waiting, not being worked on.

### WIP Limits and Their Effect

Setting WIP limits is one of the most counter-intuitive and effective improvements a team can make. Engineers resist WIP limits because they feel restrictive - "why can't I start the next ticket while waiting for PR review?" But Little's Law explains why this resistance is mistaken.

Consider a team of five engineers:

```
Without WIP limits:
- Each engineer has 3 things in progress
- Total WIP: 15
- Flow Velocity: 10 completions/week
- Flow Time: 15/10 = 1.5 weeks average

With WIP limit of 1 per engineer:
- Each engineer finishes before starting
- Total WIP: 5
- Flow Velocity: 10 completions/week (same throughput)
- Flow Time: 5/10 = 0.5 weeks average
```

By limiting WIP from 15 to 5, flow time drops by 67% without hiring a single additional engineer and without working any harder. The team ships 3x faster simply by changing how they sequence work.

### How to Improve Flow in a Go Team

**Tactic 1: Make work visible with ticket granularity**

Break features into sub-tasks of 1-3 days each. A 15-day epic has invisible flow problems. Five 3-day tasks expose queuing delays at each transition.

**Tactic 2: Standardize "Definition of Done"**

Inconsistent DoD creates context-switching overhead. Standardize it in the team's working agreement: code reviewed, tests passing, deployed to staging, and monitoring in place before a task counts as done.

### Junior → FAANG: Flow Metrics as Self-Diagnosis

Flow metrics measure how work moves through your team's system, from the moment an idea is committed to a ticket until value is delivered to users. As a junior engineer, you experience flow metrics as the subjective feeling of whether your work is moving or stuck. Flow metrics make that feeling measurable.

The most actionable flow metric for a junior engineer to understand is flow efficiency: the ratio of active work time to total elapsed time. If a feature takes 10 days from start to done but only 3 days of that involved anyone actively working on it, your flow efficiency is 30%. The other 70% was wait time: waiting for review, waiting for a test environment, waiting for a dependency. That wait time is where flow improvements come from. Identifying and naming your own wait time patterns, even informally, is the first step to improving them.

### Senior @ FAANG: Little's Law and Capacity Planning

Little's Law (average items in system equals arrival rate times average time in system) is the mathematical foundation for flow metrics and is directly applicable to capacity planning at FAANG. A team with 12 items in progress (WIP) and a cycle time of 8 days is implying a throughput of 1.5 items per day. If the team's actual throughput is 0.8 items per day, Little's Law tells you that WIP will grow until either throughput increases or WIP is actively constrained.

Flow load, the ratio of WIP to team capacity, is the leading indicator of flow degradation. Teams that allow WIP to exceed capacity spend increasing fractions of their time on context switching and coordination rather than value delivery. The FAANG platform teams that have driven the most significant developer productivity improvements have consistently done so by reducing WIP constraints, not by adding engineers. Adding engineers to a high-WIP system increases coordination overhead and often makes throughput worse before it gets better.

At the staff level, flow metrics are a governance input to headcount decisions. When an engineering director asks "should we add two engineers to this team," the answer should include current flow metrics: if flow efficiency is 30% and WIP is at 150% of capacity, the bottleneck is process and coordination, not capacity. Adding engineers will not fix a process problem. Fixing the process will often yield the equivalent of adding two engineers without the headcount cost.
