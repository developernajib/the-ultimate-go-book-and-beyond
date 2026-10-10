## Mock Interview Script: 60-Minute C++ Loop

A mock interview is the highest-use prep activity. This file is a complete 60-minute script you can run with a partner: 5 min intro, 25 min coding, 15 min design, 10 min behavioral, 5 min Qs. It includes the interviewer's prompts, expected pacing, sample questions, and a grading rubric to apply afterward.

### Setup

- Two participants: candidate and interviewer.
- Tools: shared editor (CoderPad, Google Docs, VS Code Live Share). No autocomplete (or limited). Compiling is OK if both agree, but the focus is reasoning, not iteration.
- Timer visible to both.
- The interviewer takes notes during the round, scores after.
- Hard rule: the interviewer does not give hints in the first 5 minutes of any segment. Let the candidate struggle, that is the data.

### Minute 0 to 5: Introduction

Interviewer prompt:

> Hi, thanks for the time. I am [name], I work on [team]. Today we have 60 minutes. I want to do a short intro, about 25 minutes of coding, 15 minutes of design, 10 minutes of behavioral, and we will leave 5 minutes at the end for your questions. Sound good?
> Could you give me a 2-minute summary of your background?

What the candidate should do:

- Clear, structured 90 to 120 second self-summary. No filler.
- Mention the most relevant project to the role. If applying to infra, mention infra work.
- Avoid timeline rambling. Hit two or three concrete impacts.
- End with "happy to dive deeper on any of those, or jump in".

What the interviewer is grading: communication clarity, signal strength, brevity.

### Minute 5 to 30: Coding

Interviewer prompt (pick one, do not telegraph difficulty):

#### Coding Question A: Kth Largest in a Stream

> Implement a class `KthLargestStream` that supports:
> - Constructor taking k and an initial vector of integers.
> - `int Add(int val)` adds val to the stream and returns the kth largest element.

> Constraints: k is a positive integer, the stream may have up to 10^6 elements, Add is called at most 10^6 times.

#### Coding Question B: Merge Intervals (Inclusive Boundaries)

> Given a vector of intervals where each is [start, end] (inclusive on both ends), return a new vector where overlapping intervals are merged.
> Example: [[1,3],[2,6],[8,10],[15,18]] becomes [[1,6],[8,10],[15,18]].

#### Coding Question C: Design and Implement a Bounded Blocking Queue

> Implement a thread-safe bounded queue with:
> - `void Push(T value)` blocks if full.
> - `T Pop()` blocks if empty.
> - Capacity set in the constructor.
> Multiple producers and consumers will use it.

#### Pacing Targets

| Minute | What should be happening |
|--------|--------------------------|
| 5 to 7 | Candidate reads the problem, asks clarifying questions |
| 7 to 12 | Candidate proposes an approach, discusses trade-offs |
| 12 to 22 | Candidate writes code |
| 22 to 28 | Candidate walks through test cases, finds and fixes bugs |
| 28 to 30 | Wrap up, candidate states final complexity |

If at minute 12 there is no code, the candidate is in trouble. Interviewer can nudge: "Want to start writing the structure?".

If at minute 22 the code is half done, it is too slow. The candidate should already be testing.

#### Sample Solution Sketch (Question A)

The candidate should reach this approximately:

```cpp
class KthLargestStream {
 public:
  KthLargestStream(int k, std::vector<int> nums) : k_(k) {
    for (int n : nums) {
      pq_.push(n);
      if (static_cast<int>(pq_.size()) > k_) pq_.pop();
    }
  }

  int Add(int val) {
    pq_.push(val);
    if (static_cast<int>(pq_.size()) > k_) pq_.pop();
    return pq_.top();
  }

 private:
  int k_;
  std::priority_queue<int, std::vector<int>, std::greater<>> pq_;  // min-heap of size k.
};
```

Time per Add: O(log k). Space: O(k).

#### Grading Coding (40 points)

| Criterion | Points |
|-----------|--------|
| Asks clarifying questions before coding | 5 |
| Proposes correct approach with complexity stated | 8 |
| Code compiles (or would compile) on first read | 6 |
| Handles edge cases without prompting | 6 |
| Names and structure are clean | 5 |
| Tests the code with at least one example | 5 |
| Communicates throughout | 5 |

Score:
- 35+ Excellent
- 28 to 34 Good
- 20 to 27 Mixed
- below 20 Poor

### Minute 30 to 45: System Design

Interviewer prompt (pick one):

#### Design Question A: Distributed Counter

> Design a service that lets clients increment named counters and read the current value. Targeting 1M increment/sec across 100 counter names, 10k read/sec, eventual consistency on reads is fine, durability is required.

#### Design Question B: URL Shortener

> Design tinyurl.com. The system maps a long URL to a short URL and redirects on the short URL. 1B URLs total, 100k redirect/sec, 10k creation/sec.

#### Design Question C: Notification Service

> Design a service that delivers push notifications to mobile devices. 100M devices, peak 1M notifications per second, 24-hour retry on undelivered.

#### Pacing Targets

| Minute | What should be happening |
|--------|--------------------------|
| 30 to 32 | Candidate clarifies requirements |
| 32 to 34 | Estimates scale, identifies bottlenecks |
| 34 to 36 | Sketches API |
| 36 to 41 | Draws high-level architecture, identifies key components |
| 41 to 45 | Drills into one component the interviewer points to, discusses failure modes |

The interviewer should redirect at minute 36: "spend the rest of the time on the storage layer" or "tell me more about the write path".

#### Grading Design (40 points)

| Criterion | Points |
|-----------|--------|
| Clarifies requirements before designing | 5 |
| Estimates scale and identifies the hard part | 6 |
| Picks reasonable storage technology with justification | 6 |
| Architecture handles the QPS without obvious bottleneck | 8 |
| Discusses at least one failure mode realistically | 5 |
| Drills into a component with technical depth | 5 |
| Trade-offs articulated, not just claims | 5 |

Score:
- 35+ Excellent
- 28 to 34 Good
- 20 to 27 Mixed
- below 20 Poor

### Minute 45 to 55: Behavioral

Interviewer prompts (pick two from the list):

1. Tell me about a project you led from start to finish.
2. Tell me about a time you disagreed with a peer or your manager.
3. Tell me about a project that did not go well.
4. Tell me about a time you had to learn something new quickly.
5. Tell me about a time you mentored someone.
6. Tell me about a time you made a technical decision under uncertainty.
7. Tell me about a time you got difficult feedback and how you handled it.

For each story, the interviewer asks one or two follow-ups:

- "What did you do specifically that someone else on the team did not?"
- "What was the hardest part?"
- "What would you do differently if it happened again?"

#### Pacing

5 minutes per story. The candidate should hit STAR cleanly without rambling. The interviewer should spend half the time on follow-ups, not the original.

#### Grading Behavioral (20 points)

| Criterion | Points |
|-----------|--------|
| Story is structured (STAR or equivalent) | 4 |
| Specific actions, first person, not "we" | 4 |
| Measurable outcome | 3 |
| Reflects honestly on what was hard or what would change | 4 |
| Demonstrates leadership at the appropriate level | 3 |
| Communicates concisely without rambling | 2 |

Score:
- 17+ Excellent
- 13 to 16 Good
- 9 to 12 Mixed
- below 9 Poor

### Minute 55 to 60: Candidate Questions

Interviewer prompt:

> That is the structured part. We have 5 minutes. What questions do you have for me?

Strong candidate questions:

- "What is the technical decision you most regret on this team in the last year, and what did you learn?"
- "How does code review work? Are senior engineers expected to review junior PRs?"
- "What is the on-call rotation like? How is on-call load measured?"
- "What is the team's current biggest technical debt?"
- "How does a project go from idea to ship on this team?"

Weak candidate questions:

- "What is the pay?" (not for this round, ask the recruiter)
- "Do you like working here?" (vague, predictable)
- "What is the tech stack?" (already on the job description)

#### Grading the Questions Round

This is informal but it is a signal. A candidate who asks substantive, specific questions about how the team operates is engaged and senior. A candidate who asks no questions or only logistics signals disinterest.

### Total Score and Calibration

Maximum total: 100 points (40 coding + 40 design + 20 behavioral).

| Total | Signal | What it maps to |
|-------|--------|-----------------|
| 85 to 100 | Strong Hire | Excellent across the board, hire at L5+ |
| 70 to 84 | Hire | Good with some Excellent, hire at L5 or below |
| 55 to 69 | Lean Hire / No Hire | Mixed signal, depends on the bar for the level |
| Below 55 | No Hire | Multiple weak rounds |

Calibrate against your target. If you are interviewing for Google L5 and your mock score is 65, you are not ready. Practice the weakest segment until 75+.

### Running the Mock Effectively

Tips for the interviewer:

- Stay quiet during coding. Resist the urge to explain. The candidate's silence under pressure is data.
- Ask "what is the time complexity" exactly once, after they think they are done.
- For design, redirect actively. The candidate who designs the perfect system but never gets to the storage layer scored low because they did not control time.
- For behavioral, listen for "I" vs "we". Ask "what did you specifically do" if they slip into "we".

Tips for the candidate:

- Treat it like the real thing. No phone, no other tabs.
- Record yourself if your partner agrees. Watching the recording is brutal and effective.
- After the mock, write down three concrete things to fix before the next mock. Generic feedback ("be more confident") is worthless. Specific feedback ("I used 'we' four times in the leadership story") is gold.

### Doing Five Mocks Before the Real Loop

A typical preparation arc:

- Mock 1: identify the weakest area. Probably behavioral if you are coding-strong.
- Mock 2: focus on that area, retry the weak round.
- Mock 3: full loop, different problems.
- Mock 4: full loop with a higher-bar partner.
- Mock 5: full loop the week before, calibrated to the target company.

Five mocks at 60 minutes each plus 30 minutes of feedback per session is 7.5 hours total. That is a small price for the increase in passing rate.

### Senior at FAANG: Mocking Is the Single Highest-ROI Prep

LeetCode at home is comfortable. Mock interviews are uncomfortable, which is exactly what makes them work. The performance gap between a candidate who has done 5 mocks and one who has done none is enormous, and it shows in the first 90 seconds. Find a partner. Run the script. Repeat.
