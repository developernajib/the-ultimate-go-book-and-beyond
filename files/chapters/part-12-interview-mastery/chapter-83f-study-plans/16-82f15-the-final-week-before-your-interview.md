## 83F.15 The Final Week Before Your Interview

You've prepared for weeks or months. Now it's the last 7 days before your onsite. This is not the time to learn new topics, it's the time to sharpen what you know and get your mind and body ready.

### Day 7 (One Week Out): Review, Don't Learn

**Do:**
- Review your top 20 solved problems. Re-solve 5 of them from scratch without looking at your notes
- Read through your STAR story bank. Practice saying each story out loud in under 2 minutes
- Review your system design templates (URL shortener, chat system, news feed)

**Don't:**
- Start a new algorithm topic you haven't studied
- Attempt hard problems you've never seen, it will destroy your confidence
- Read "one more" system design article. You know enough

### Day 6: System Design Day

Spend today doing full system design mock sessions (45 minutes each):

1. Pick a problem you haven't practiced recently (e.g., "Design Twitter" or "Design a rate limiter")
2. Set a 45-minute timer
3. Go through the full framework: requirements → estimation → high-level design → deep dive → trade-offs
4. Talk out loud the entire time, even if you're alone

Do 2-3 of these. Review where you stumbled. Don't try to memorize designs, focus on your framework.

### Day 5: Coding Speed Day

Today is about speed, not learning:

1. Pick 10 medium problems you've already solved
2. Set a 20-minute timer per problem
3. Solve each from scratch. Focus on writing clean, correct code on the first attempt
4. Track your times. You should finish most mediums in 15-20 minutes

If you can't finish a previously-solved medium in 20 minutes, your bottleneck is coding speed, not algorithm knowledge. Practice your Go templates (binary search, BFS, sliding window) until they're muscle memory.

### Day 4: Behavioral Day

Practice your behavioral stories out loud:

1. **Record yourself** answering 5 behavioral questions (use your phone)
2. **Listen back**. Are you rambling? Cut to 2 minutes per answer
3. **Time each story** , Situation: 30 sec, Task: 15 sec, Action: 90 sec, Result: 30 sec
4. **Prepare 2 stories per signal**: leadership, conflict, failure, ambiguity, customer focus

Have someone mock-interview you if possible. Even a non-technical friend asking behavioral questions is valuable practice.

### Day 3: Light Practice + Logistics

**Morning:** Solve 3-5 easy/medium problems you're comfortable with. This is maintenance, not growth.

**Afternoon:** Handle all logistics:
- Confirm interview time, location (or video link), interviewer names
- If onsite: plan your route, check parking, set 2 alarms
- If virtual: test your camera, microphone, screen sharing, IDE, and internet connection
- Prepare your outfit (business casual for most tech companies)
- Charge all devices

### Day 2: Rest Day (Yes, Really)

Your brain consolidates learning during rest. Cramming today will make you worse tomorrow.

**Allowed:**
- A light walk or exercise
- Skimming your cheat sheet once
- Re-reading your STAR stories
- Watching a relaxing system design walkthrough video

**Not allowed:**
- Attempting new problems
- Reading about topics you don't know
- Staying up late studying
- Doom-scrolling interview horror stories on Blind/Reddit

### Day 1: Interview Day

**Morning routine:**
- Wake up early enough to not rush. Eat a real breakfast
- Review your one-page cheat sheet (key patterns, templates, time complexities)
- Do ONE easy problem as a warm-up, like stretching before a race
- Arrive 15 minutes early (or test your video setup 15 min before)

**During the interview:**
- Breathe. Pause before answering. Think for 10 seconds before speaking
- Ask clarifying questions even if the problem seems clear
- Write code incrementally, get a skeleton working, then fill in details
- Test with a concrete example before saying "I'm done"
- When stuck, say "Let me think about this for a moment" , silence is OK

**Between rounds:**
- Use bathroom breaks to reset mentally
- Don't replay the previous round. It's done. Focus on the next one
- Drink water. Eat a snack if there's time
- Each round is evaluated independently, a bad round doesn't determine the outcome

### Your One-Page Cheat Sheet

Create this and review it once on the morning of the interview:

```
TIME COMPLEXITIES:
Binary Search: O(log n)  |  Sorting: O(n log n)
HashMap lookup: O(1)     |  BFS/DFS: O(V + E)
Two Pointers: O(n)       |  Sliding Window: O(n)
DP (typical): O(n*m)     |  Heap ops: O(log n)

PATTERN TRIGGERS:
Sorted input     → Binary Search / Two Pointers
Subarray/substr  → Sliding Window / Prefix Sum
Pairs/complements → HashMap
Tree/Graph       → BFS (shortest) / DFS (all paths)
All combinations → Backtracking
Overlapping sub  → Dynamic Programming
Top K / Kth      → Heap
Intervals        → Sort + sweep

GO GOTCHAS:
- Initialize maps before writing: m = make(map[K]V)
- Slices share underlying arrays: copy() for independence
- Goroutine loop var capture (pre-1.22)
- nil interface vs nil pointer in interface

STAR FORMAT:
Situation (30s) → Task (15s) → Action (90s) → Result (30s)
Always quantify results. Always explain what YOU did.
```

Print this or save it on your phone. One glance in the morning is all you need.


### Junior → FAANG: Final Week Interview Preparation

The final week before your interview loop is not for learning new material. It is for consolidation and confidence building. Review your strongest system design patterns, run through your behavioral stories once more, and solve 2-3 familiar coding problems each day to maintain fluency. Avoid introducing new topics in the final week: the cognitive overhead of absorbing new material competes with the consolidation of what you already know. Focus on mental and physical health: maintain sleep, reduce alcohol, and build in brief relaxation periods.

### Senior @ FAANG: Final Week as a Peak Performance Protocol

Senior candidates in the final week should follow a structured peak performance protocol. Days 7-5 before the interview: complete one full system design mock with feedback, review and practice the weakest two behavioral stories, and solve one medium-difficulty coding problem per day. Days 4-3: reduce preparation intensity, review your notes on the target company's engineering culture and any company-specific talking points, and get 8 hours of sleep both nights. Day 2: light review only (30 minutes maximum), no new material, physical exercise, early sleep. Day 1 (interview day): review your five key behavioral stories in the morning, a brief technical warm-up (one easy coding problem, one system design pattern review), and then no more review. The preparation is done. Trust the work.
