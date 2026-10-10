## 83G.16 The Interview Day Checklist

Print these checklists. Use them. They exist so that on interview day, your brain does not have to remember logistics --- it can focus entirely on performing.

### Complete Pre-Flight Checklist (The Night Before)

```
PRE-INTERVIEW CHECKLIST (Night Before)

Physical:
[ ] Exercised today (moderate intensity)
[ ] Hydrated throughout the day
[ ] Ate a clean dinner
[ ] Clothes laid out
[ ] Two alarms set
[ ] Phone charging
[ ] Bag packed (if in-person)

Technical:
[ ] Reviewed pattern cheat sheet (not studied --- reviewed)
[ ] Re-read 2-3 solved problems
[ ] Reviewed STAR stories
[ ] Reviewed quick reference card

Logistics:
[ ] Know the interview time and timezone
[ ] Know the interview format for each round
[ ] Have the meeting link / address
[ ] Have the recruiter's phone number
[ ] Backup plan for tech issues (if virtual)
[ ] Route planned (if in-person)

Mental:
[ ] Wrote the Confidence List (10 things I'm good at)
[ ] Did the worst-case exercise (nothing catastrophic happens)
[ ] Did the visualization exercise
[ ] Set phone to Do Not Disturb for tomorrow
[ ] Told housemates/family about the schedule

Done. Go to bed. You are ready.
```

### Virtual Interview Tech Checklist (Morning Of)

Run this checklist before you join the first call:

```
VIRTUAL INTERVIEW TECH CHECK (30 minutes before)

[ ] Computer charged and plugged in
[ ] Internet working (run a speed test)
[ ] Camera working (check angle and lighting)
[ ] Microphone working (test in app settings)
[ ] Headphones connected and audio clear
[ ] Video call app updated (no "update required" popup)
[ ] Screen sharing tested (share the correct window)
[ ] Editor open and ready (font size readable when shared)
[ ] All notifications silenced (computer and phone)
[ ] Unnecessary apps closed
[ ] Browser tabs closed (except the interview tab)
[ ] Background is clean/blurred
[ ] Water at desk
[ ] Pen and paper ready
[ ] Door closed, "Do Not Disturb" sign up
[ ] Backup plan ready (phone hotspot, recruiter's phone number)

Open the interview link 5 minutes early.
```

### In-Person Interview Packing List

For onsite loops, pack the night before:

```
IN-PERSON INTERVIEW BAG

Must have:
[ ] Government ID (for building security)
[ ] Phone (silenced) + charger
[ ] Copies of resume (3-5 printed)
[ ] Pen and notepad
[ ] Water bottle
[ ] Snacks (nuts, energy bars, fruit)
[ ] The recruiter's phone number
[ ] Directions (printed or saved offline, don't rely on signal)

Nice to have:
[ ] Breath mints or gum
[ ] Deodorant (for full-day onsites)
[ ] Tissues
[ ] Backup pair of headphones (for virtual whiteboard rounds within an onsite)
[ ] Small towel for sweaty hands
[ ] Quick reference card (review before entering, leave in bag during interview)

Do NOT bring:
[ ] A laptop (unless told to for a coding exercise)
[ ] Books or study materials (you're done studying)
[ ] Excessive personal items
```

### Quick Reference Card (Patterns, Complexity, Go Snippets)

Create this card and review it the morning of your interview. Do not look at it during the interview.

```
QUICK REFERENCE CARD (review, don't memorize)

COMMON PATTERNS AND WHEN TO USE THEM:
─────────────────────────────────────
Sliding Window    → Subarray/substring with constraint
Two Pointers      → Sorted array, pair finding
BFS               → Shortest path (unweighted), level-order
DFS               → All paths, connected components, tree traversal
Binary Search     → Sorted data, search space reduction
Dynamic Prog.     → Optimal substructure + overlapping subproblems
Greedy            → Locally optimal → globally optimal
Monotonic Stack   → Next greater/smaller element
Union-Find        → Connected components, cycle detection
Trie              → Prefix matching, autocomplete
Topological Sort  → Task ordering with dependencies

COMPLEXITY CHEAT SHEET:
───────────────────────
O(1)       → Hash map lookup, array index
O(log n)   → Binary search, balanced BST
O(n)       → Single pass, hash map build
O(n log n) → Sorting (merge sort, heap sort)
O(n^2)     → Nested loops, brute force pairs
O(2^n)     → Subsets, brute force combinations
O(n!)      → Permutations

GO GOTCHAS UNDER PRESSURE:
──────────────────────────
• make(map[K]V) to initialize maps
• arr[len(arr)-1] for last element (not arr[len(arr)])
• for i, v := range slice (i=index, v=value)
• if err != nil { return ..., err }
• go func(param Type) { ... }(arg) captures loop vars (Go 1.22+ scopes per-iteration)
• defer runs LIFO (last in, first out)
• Slices and maps pass descriptor headers with shared underlying data
• strings are immutable; use strings.Builder for concatenation
```


### Junior → FAANG: Interview Day Checklist

A written interview day checklist reduces the cognitive load of logistics on the interview day, letting you focus on performance. The checklist should include: equipment check (laptop charged, headset working, camera working, background neutral), environment check (quiet room, Do Not Disturb mode on all devices, water on desk), login check (virtual interview platform logged in and tested), and materials check (notepad and pen for scratch work, a list of your 8-10 behavioral story one-liners as a quick reference). Run the checklist 30 minutes before the first round.

### Senior @ FAANG: Interview Day Checklist as a Pre-Flight Protocol

Senior candidates should treat the interview day checklist as a professional pre-flight protocol with zero tolerance for checklist skipping. The cost of a failed checklist item (microphone not working, unable to log into the shared coding environment) is not just the lost time. It is the anxiety spike from an unexpected failure that can disrupt performance in the subsequent rounds. The senior-level addition to the checklist is an explicit 'out' decision: if a checklist item fails and cannot be resolved in 10 minutes, what is the protocol? (Call the recruiter, request a reschedule, use the backup device.) Having this decision pre-made prevents the paralytic uncertainty that arises when the pre-interview environment fails unexpectedly.

---
