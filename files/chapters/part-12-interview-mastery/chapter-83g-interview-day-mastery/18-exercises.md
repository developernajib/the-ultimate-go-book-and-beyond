## Exercises

### Exercise 1: The Pressure Simulation

**Objective:** Practice performing under artificial time pressure to build tolerance.

**Setup:**
1. Choose a Medium difficulty LeetCode problem you have not solved.
2. Set a 25-minute timer (shorter than a real interview to increase pressure).
3. Open a plain text editor (no autocomplete, no syntax highlighting).
4. Start a voice recorder or have a friend listen.

**During the exercise:**
- You must think aloud the entire time (no silent coding).
- You must explain your approach before coding.
- You must test your code by tracing through an example.
- If you get stuck, practice the recovery techniques from Section 83G.6.

**After the exercise:**
- Listen to the recording (or get feedback from your friend).
- Evaluate: Did you think aloud? Did you ask clarifying questions? How did you handle getting stuck?
- Rate yourself on the self-evaluation rubric from Section 83G.13.

### Exercise 2: The Recovery Drill

**Objective:** Practice recovering from getting stuck.

**Setup:**
1. Choose a Hard difficulty LeetCode problem (deliberately too hard).
2. Set a 15-minute timer.
3. You are not expected to solve this problem.

**During the exercise:**
- Practice every recovery technique from Section 83G.6:
 - Think aloud through brute force
 - Work backwards from the output
 - Draw pictures and examples
 - Try smaller inputs
 - Ask for a hint (pretend a friend is the interviewer)
- When the timer rings, write down what progress you made.

**Evaluation:** The goal is not to solve the problem. The goal is to make progress and communicate clearly while stuck. Rate yourself on: "If an interviewer watched me, would they see a thoughtful engineer working through a hard problem, or a panicking candidate staring at a blank screen?"

### Exercise 3: The Full Mock Day

**Objective:** Simulate the endurance of a full-day onsite.

**Setup:**
1. Block 4 hours on a Saturday.
2. Prepare 4 mock interviews:
 - Round 1 (45 min): Coding problem (use one from Chapter 83C)
 - Round 2 (45 min): System design (use one from Chapter 81)
 - Round 3 (30 min): Behavioral (have a friend ask 5 STAR questions from Chapter 82)
 - Round 4 (45 min): Coding problem (harder than round 1)
3. Take 10-minute breaks between rounds (use the reset protocol from Section 83G.9).
4. Eat lunch between rounds 2 and 3.

**After the exercise:**
- Score yourself on each round.
- Note how your performance changed across the day.
- Identify your energy patterns (when were you sharpest? When did you fade?).
- Adjust your real interview strategy based on these observations.

### Exercise 4: The Difficult Interviewer Drill

**Objective:** Practice maintaining composure with a challenging interviewer.

**Setup:**
1. Find a friend willing to play the "difficult interviewer" role.
2. Give them these instructions:
 - For 15 minutes, be a silent interviewer (give no feedback whatsoever)
 - For 15 minutes, be an aggressive questioner (challenge every decision)
 - Do not break character

**During the exercise:**
- Solve a coding problem while dealing with each interviewer type.
- Practice the strategies from Section 83G.10.
- Focus on maintaining your composure and continuing to make progress.

**After the exercise:**
- Discuss with your friend how you handled the pressure.
- Ask them: "Would you hire someone who performed like I just did?"
- Identify which interviewer type was harder for you and why.

### Exercise 5: The Go Under Pressure Drill

**Objective:** Practice writing clean Go code under artificial time pressure, focusing on the common mistakes from Section 83G.12.

**Setup:**
1. Open a plain text editor (not GoLand or VS Code with Go extensions --- no autocomplete).
2. Set a 20-minute timer.
3. Implement the following from memory (no reference material):

```
Task: Build a concurrent-safe LRU cache in Go.

Requirements:
- Get(key string) (string, bool) -- returns value and whether key exists
- Put(key string, value string) -- inserts or updates
- Capacity is fixed at creation time
- When capacity is exceeded, evict the least recently used item
- Must be safe for concurrent use by multiple goroutines
- Use container/list and sync.RWMutex

Write the full implementation including:
- Struct definition
- NewLRUCache factory function
- Get and Put methods
- Proper locking (RLock for reads, Lock for writes)
- Proper map initialization
```

**During the exercise:**
- Think aloud as if an interviewer were watching.
- Write the code on paper first if that helps (simulating a whiteboard).
- Focus on the Go-specific pitfalls: initialize the map, use defer for unlock, handle the zero-value/comma-ok pattern.

**After the exercise:**
- Check your code against a reference implementation.
- Count the Go-specific errors you made (uninitialized map, wrong lock type, missing defer, etc.).
- If you made more than 2 Go-specific errors, repeat this exercise with a different data structure (concurrent-safe queue, concurrent-safe set) until the patterns are automatic.

**Evaluation criteria:**
- Did you initialize all maps with `make()`?
- Did you use `defer` for unlocking?
- Did you use `sync.RWMutex` (not just `sync.Mutex`) for read-heavy access?
- Did you handle the `container/list` correctly (type assertions for `interface{}` values)?
- Would your code compile if pasted into a Go file? (Test it.)

### Exercise 6: The Post-Interview Debrief

**Objective:** Build the habit of structured self-reflection.

**Setup:**
1. After your next mock interview (or real interview), complete the full debrief template from Section 83G.13 within 30 minutes.
2. Wait 48 hours, then re-read your debrief.
3. Create a specific, 2-week study plan based on the weaknesses you identified.

**Evaluation:**
- Did your debrief capture enough detail to be useful 48 hours later?
- Is your study plan specific ("Practice 10 sliding window problems") rather than vague ("Get better at coding")?
- Did you identify at least one non-technical area for improvement (communication, composure, time management)?


### Junior → FAANG: Interview Day Mastery Exercises

The exercises in this section produce concrete artifacts and practiced skills: write your personalized interview day checklist, practice your between-round reset protocol for 5 minutes, and conduct one mock round using your full coding playbook (timer, think-aloud narration, testing phase). These exercises are low in time investment but high in impact because they build the execution habits that operate under pressure.

### Senior @ FAANG: Exercises as Protocol Validation Under Realistic Conditions

Senior candidates should conduct at least two of these exercises under realistic conditions: actual time pressure, video recording, and post-session review. The goal is to identify any execution protocol gaps before the real interview. Common senior-level gaps found in exercise review: the getting-stuck protocol breaks down when the stuck feeling is genuine (not simulated), the between-round reset time is too short for the actual recovery needed, or the morning routine is theoretically correct but has not been tested in the morning before a high-stakes activity. Each gap discovered in exercise is one less gap discovered in the real interview.

---
