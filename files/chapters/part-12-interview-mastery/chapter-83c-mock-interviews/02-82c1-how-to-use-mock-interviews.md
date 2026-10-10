## 83C.1 How to Use Mock Interviews

### Self-Practice vs. Peer Practice

Mock interviews work in two modes, and you need both.

**Self-practice** is where you build raw skill. You set a timer, read the problem statement (cover the solution), and work through it alone. The advantage is frequency - you can do three self-practice sessions in the time it takes to schedule one peer session. The disadvantage is that you cannot simulate the social pressure of a real interview, and you cannot practice the communication skills that account for roughly 30% of your interview score.

**Peer practice** is where you build performance skill. One person plays interviewer, the other plays candidate. The interviewer reads the problem, gives hints when appropriate, asks follow-up questions, and scores the candidate using the rubric. Then you switch roles. The advantage is realism - the social pressure, the need to think aloud, the hints and follow-ups all mirror real interviews. The disadvantage is scheduling overhead and the temptation to be too lenient with your partner.

```
┌──────────────────────────────────────────────────────────────────┐
│              MOCK INTERVIEW PRACTICE FRAMEWORK                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Week 1-2: Self-Practice Foundation                              │
│  ├── 3 coding mocks per week (45 min each, timed)                │
│  ├── 1 system design mock per week (45 min, speak aloud)         │
│  └── Write out 10 STAR stories for behavioral                    │
│                                                                  │
│  Week 3-4: Peer Practice Integration                             │
│  ├── 2 peer coding mocks per week (alternate roles)              │
│  ├── 1 peer system design per week                               │
│  ├── 1 peer behavioral per week                                  │
│  └── Continue 2 self-practice coding per week                    │
│                                                                  │
│  Week 5-6: Full Loop Simulation                                  │
│  ├── 1 full onsite simulation per week (4 interviews, 1 day)     │
│  ├── Focus practice on weakest areas                             │
│  └── Review and refine STAR stories                              │
│                                                                  │
│  Week 7+: Maintenance During Active Interviewing                 │
│  ├── 1 coding mock before each real interview                    │
│  ├── Review system design notes morning-of                       │
│  └── Warm up with 1 easy + 1 medium LeetCode                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Recording and Reviewing

Record your mock interviews. Use screen recording for coding mocks and audio recording for system design and behavioral mocks. Then review them - not immediately, but the next day, when you have enough distance to evaluate yourself honestly.

When reviewing recordings, look for these specific signals:

1. **Dead air**: Periods longer than 15 seconds where you are silent. In a real interview, silence signals being stuck. Practice narrating your thought process even when uncertain.

2. **Backtracking**: Moments where you erase significant code and start over. This suggests you jumped to coding before your approach was solid. Practice spending more time on the plan.

3. **Edge case blindness**: Did you test your solution with empty input, single element, duplicates, negative numbers, maximum values? If not, an interviewer will ask about them.

4. **Communication quality**: Do you explain what you're doing and why? Do you check in with the "interviewer" before major decisions? Do you respond to hints constructively?

5. **Time management**: Did you spend the right amount of time on each phase? Most candidates spend too long clarifying and too little time testing.

### Scoring Yourself Honestly

The single biggest failure mode in self-practice is self-deception. You glance at the solution "just to check one thing," you give yourself an extra 10 minutes, you skip the follow-up questions. Every accommodation you give yourself is preparation debt that will come due in the real interview.

Rules for honest self-assessment:

- **The timer is sacred.** When it rings, put your pencil down. Evaluate what you have, not what you would have had with five more minutes.
- **No peeking.** If you look at the solution before finishing, the mock is invalidated. Score it as a fail and redo it next week.
- **Follow-up questions count.** A correct solution with poor follow-up responses is a Lean Hire, not a Hire.
- **Communication counts even in self-practice.** Speak your thoughts aloud. If you cannot articulate your approach verbally, you cannot do it in an interview.

### Time Management Practice

Every coding interview follows the same time structure. Practice it until it is automatic:

```
┌──────────────────────────────────────────────────────────────────┐
│              45-MINUTE CODING INTERVIEW TIMELINE                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Minutes 0-5: Problem Clarification                              │
│  ├── Read the problem completely                                 │
│  ├── Ask 2-3 clarifying questions                                │
│  ├── Confirm input/output format and constraints                 │
│  └── State your understanding back to the interviewer            │
│                                                                  │
│  Minutes 5-12: Approach Discussion                               │
│  ├── Think through 1-2 approaches                                │
│  ├── Analyze time and space complexity of each                   │
│  ├── Choose an approach and explain why                          │
│  └── Get interviewer buy-in before coding                        │
│                                                                  │
│  Minutes 12-35: Implementation                                   │
│  ├── Write clean, readable code                                  │
│  ├── Use meaningful variable names                               │
│  ├── Handle edge cases as you go                                 │
│  └── Narrate what you're doing                                   │
│                                                                  │
│  Minutes 35-42: Testing                                          │
│  ├── Trace through with a simple example                         │
│  ├── Test edge cases (empty, single, max)                        │
│  ├── Fix any bugs found                                          │
│  └── Discuss time and space complexity                           │
│                                                                  │
│  Minutes 42-45: Follow-up & Questions                            │
│  ├── Answer interviewer follow-ups                               │
│  ├── Discuss optimizations if time permits                       │
│  └── Ask a thoughtful question about the team                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```


### Junior → FAANG: Mock Interview Usage Protocol

The protocol for getting value from mock interviews: treat it as the real thing (no pausing to look things up, no breaking frame), have the mock interviewer give feedback only at the end, record the session if possible for self-review, and write down three specific improvement actions immediately after. The most common usage mistake is treating mock interviews as low-stakes practice sessions where it is acceptable to stop and restart or to ask 'is this the right direction' repeatedly. Train as you fight.

### Senior @ FAANG: Mock Interview as a Deliberate Practice System

Senior candidates applying deliberate practice principles to mock interviews should use a focused repetition model: identify a specific weakness (e.g., the depth of your trade-off analysis is insufficient), design a mock specifically to practice that weakness (ask the mock interviewer to probe specifically on trade-offs), review the results, and repeat. This is more effective than generic full-loop mocks where you practice everything at once, because deliberate practice requires focused attention on a specific skill at the edge of your current ability. The meta-skill being developed is adaptability: the ability to read the interviewer's signals and adjust depth, breadth, and focus in real time, which cannot be developed through solo study.

---
