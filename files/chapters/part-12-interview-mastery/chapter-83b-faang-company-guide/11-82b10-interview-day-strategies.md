## 83B.10 Interview Day Strategies

### Morning Routine

Interview performance degrades sharply when you walk in under-prepared physically or mentally. The checklist below is battle-tested: the warm-up problem the morning of the interview reactivates pattern-recognition circuits that have been dormant overnight, and reviewing a handful of Go idioms keeps your working memory primed for the language rather than forcing you to recall syntax under pressure. Logistics failures, a dead mic, a forgotten Zoom link, are entirely avoidable stress, so treat equipment checks as non-negotiable.

```
┌───────────────────────────────────────────────────────────────────┐
│                  INTERVIEW DAY CHECKLIST                          │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  The Night Before:                                                │
│  □ Prepare clothes / check camera+mic for virtual                 │
│  □ Review your STAR stories (read, don't memorize)                │
│  □ Review your "questions for the interviewer" list               │
│  □ Set 2 alarms                                                   │
│  □ Sleep 7-8 hours minimum                                        │
│                                                                   │
│  Morning (3 hours before):                                        │
│  □ Wake up, hydrate (water, not just coffee)                      │
│  □ Light exercise (15-20 min walk)                                │
│  □ Nutritious breakfast (protein + complex carbs)                 │
│  □ Warm-up: solve 1 easy problem (confidence builder)             │
│  □ Review 2-3 Go idioms (channels, interfaces, error handling)    │
│                                                                   │
│  30 Minutes Before:                                               │
│  □ Test equipment (camera, mic, internet)                         │
│  □ Close all unnecessary apps                                     │
│  □ Open blank editor/IDE                                          │
│  □ Have water within reach                                        │
│  □ Take 5 deep breaths                                            │
│                                                                   │
│  During Interview:                                                │
│  □ Smile and be personable in the first 30 seconds                │
│  □ Clarify the problem before coding                              │
│  □ Think out loud continuously                                    │
│  □ Write clean code from the start                                │
│  □ Test with examples before saying "done"                        │
│  □ Ask thoughtful questions at the end                            │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Time Management During Problems

The 45-minute coding round should be divided as follows:

**Minutes 0-5: Understand and Clarify**
- Restate the problem in your own words
- Ask about input constraints: size, range, edge cases
- Ask about expected output format
- Confirm: "So I need to return X given Y, where Z constraints apply?"

**Minutes 5-10: Plan Your Approach**
- Identify the pattern (sliding window, BFS, DP, etc.)
- Discuss 2-3 approaches with time/space complexity
- Choose the optimal approach and explain why
- Write pseudocode or outline on the side

**Minutes 10-35: Implement**
- Write clean, well-structured Go code
- Use meaningful variable names
- Handle edge cases as you go (don't leave for later)
- Narrate what you are doing: "I'm using a map here for O(1) lookup because..."

**Minutes 35-42: Test**
- Walk through your code with the given example
- Test with an edge case (empty input, single element, large input)
- Fix any bugs you find
- Discuss time and space complexity

**Minutes 42-45: Wrap Up**
- Ask if the interviewer has follow-up questions
- Discuss potential optimizations you did not implement
- Ask your prepared question for the interviewer

### How to Handle Being Stuck

**Level 1: Reframe (30 seconds)**
- "Let me take a step back and think about this differently."
- Re-read the problem statement - you may have missed a constraint
- Try a concrete example with small input

**Level 2: Simplify (1 minute)**
- Solve a simpler version of the problem first
- "What if the array were sorted?" or "What if there were only 2 elements?"
- The simplified solution often reveals the pattern for the full solution

**Level 3: Pattern Match (1 minute)**
- Run through your mental checklist of patterns: hash map, two pointers, sliding window, BFS/DFS, binary search, DP, stack, heap, trie, union-find
- Ask yourself: "What data structure would make this O(n)?"
- Consider: "Have I seen a similar problem?"

**Level 4: Communicate (30 seconds)**
- "I'm considering a few approaches. Let me think through the trade-offs."
- Share your partial thinking: "I think this is a sliding window problem because..."
- The interviewer may give a hint if they see you are on the right track

**Never do:**
- Sit in silence for more than 60 seconds
- Say "I don't know" without attempting the problem
- Panic and start coding without a plan

### Communication Frameworks

**The REACTO Framework for Coding Problems:**
- **R**epeat: Restate the problem
- **E**xample: Walk through an example
- **A**pproach: Describe your algorithm
- **C**ode: Write the implementation
- **T**est: Verify with test cases
- **O**ptimize: Discuss improvements

**The UMPIRE Framework for System Design:**
- **U**se cases: What does the system need to do?
- **M**apping: Map use cases to components
- **P**lan: Design the high-level architecture
- **I**mplement: Detail each component
- **R**eview: Identify bottlenecks and single points of failure
- **E**valuate: Discuss trade-offs and alternatives

### Whiteboard vs. IDE vs. CoderPad Tips

**Google Docs (Google):**
- No syntax highlighting - use consistent indentation manually
- Type at your normal speed - do not rush, mistakes are harder to fix
- Use `//` comments to explain your thinking as you code
- Test by tracing through the code with comments

**CoderPad (Meta, many others):**
- You can run your code - take advantage of this
- Write a `main()` function with test cases
- Use `fmt.Println` for debugging during development, remove before submitting
- Test edge cases by running them

**Virtual Whiteboard (some companies):**
- Write bigger than you think - small handwriting is hard to read on screen
- Use colors to distinguish different parts of your solution
- Leave space between lines for edits
- Practice on a physical whiteboard before the interview

**IDE/Shared Editor (Apple, some teams):**
- Use Go-specific features: `if err != nil` patterns, proper struct definitions
- Show you know the tooling: mention `go vet`, `go test`, `go build`
- Write testable code - separate logic from I/O


### Junior → FAANG: Interview Day Execution Strategies

Interview day strategy starts the night before: review your key stories, your system design patterns, and your algorithms without intensive study (cramming the night before increases anxiety without improving performance). Get 7-8 hours of sleep. On the day, have a normal breakfast, arrive or log in 10 minutes early, and treat each round as independent. If one round goes poorly, do not let it affect your performance in subsequent rounds: final hiring decisions integrate all rounds, and a poor first round is often offset by strong later rounds.

### Senior @ FAANG: Interview Day Portfolio Management at the Senior Level

Senior candidates in a multi-day or multi-loop interview period should manage their performance as a portfolio, not as a set of independent events. The implication: after each interview round, write brief notes on what went well, what was shaky, and which topics came up. These notes inform the next round's warm-up. If a gap in a specific topic area was exposed, you have the evening to refresh that topic. Interviewers at most companies do not share notes with each other before the debrief, so the same topic being probed in multiple rounds is not unusual. Also manage your energy actively: senior interviews often run 5-6 hours with multiple rounds, and cognitive performance degrades without intentional recovery between rounds.

---
