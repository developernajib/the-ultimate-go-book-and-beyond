## Summary

- **DP requires**: optimal substructure + overlapping subproblems
- **Top-down** (memoization) is intuitive. **bottom-up** (tabulation) avoids recursion overhead
- **State definition** is crucial: what variables describe a subproblem?
- **Space optimization**: often possible by only keeping necessary previous states
- Common patterns: Fibonacci, Grid paths, String matching, Knapsack, Intervals
- Practice recognizing patterns to quickly identify DP applicability

DP problems require significant practice. Start with classic problems, understand the patterns, and gradually tackle more complex variants.

### Junior → FAANG: From Summary to Action Plan

The summary above distills the chapter to six bullet points. Convert each bullet into a concrete action item for your interview preparation.

"DP requires optimal substructure + overlapping subproblems" means: for the next 20 DP problems you practice, state both properties out loud before writing any code. Make it a non-negotiable step.

"Top-down is intuitive, bottom-up avoids recursion overhead" means: for every top-down solution you write, convert it to bottom-up before moving to the next problem. The conversion is a skill that must be practiced, not assumed.

"State definition is crucial" means: spend at least 5 minutes on state design before writing the recurrence. If you cannot state what `dp[i]` or `dp[i][j]` means in one sentence, the implementation will be wrong.

"Space optimization" means: for every 2D DP solution, identify whether rows can be rolled into a 1D array. If yes, implement the optimization and verify it produces identical results against the unoptimized version. "Can you reduce the space?" is among the most predictable follow-ups in a DP interview, so having the answer ready costs nothing and skipping it costs the loop.

Start your practice sequence with: climbing stairs, coin change, longest increasing subsequence, longest common subsequence, 0/1 knapsack, and edit distance. These six cover the Fibonacci, unbounded knapsack, LIS, string, 0/1 knapsack, and two-sequence patterns, and they build the recognition reflex that makes unfamiliar problems tractable.

### Senior @ FAANG: Summary as a Hiring and Coaching Framework

The six bullet points in this summary are also six dimensions along which a senior or staff engineer can evaluate a junior candidate's DP readiness during an interview or during onboarding.

Dimension 1 (property identification): can the candidate state optimal substructure and overlapping subproblems correctly for a problem they have never seen? A candidate who can do this for novel problems is ready for FAANG DP interviews. A candidate who can only do it for problems they have practiced is not.

Dimension 2 (approach selection): does the candidate know when to use top-down versus bottom-up and can they justify the choice? This separates mechanical memorization from genuine understanding.

Dimension 3 (state design): is the state definition minimal (no redundant dimensions) and complete (sufficient to derive the answer from the state alone)? Incorrect state design is the root cause of most DP bugs and is the hardest skill to develop.

Dimension 4 (space optimization): can the candidate correctly apply rolling-array optimization, including identifying the correct loop direction? This is a production readiness signal: production DP code should always apply this optimization when the memory difference is significant.

Dimension 5 (pattern breadth): which pattern families does the candidate know? Fibonacci and knapsack only is a junior level. The full set covered in this chapter, through interval DP and tree DP, is the senior level. Bitmask DP and DP on graphs is the staff level.

Dimension 6 (application breadth): can the candidate identify DP-structured problems in system design scenarios? This is the senior/staff differentiator. It transforms DP from an interview subject into an engineering thinking tool.

### Junior → FAANG: Building a DP Practice Roadmap From This Summary

The six bullets in the summary define a six-week practice roadmap. Week 1: Fibonacci variants (climbing stairs, house robber, decode ways). Week 2: Knapsack variants (coin change, subset sum, partition equal subset, target sum). Week 3: 2D DP (LCS, edit distance, unique paths, minimum path sum). Week 4: LIS and string DP (palindrome, regex matching). Week 5: Decision-making DP (all stock variants) and tree DP. Week 6: Interval DP (burst balloons, matrix chain) and consolidation.

After each week, do a timed review: for each problem in that week's set, write the state definition and recurrence (not the full code) in under 2 minutes per problem. If you cannot do this, you have not internalized the pattern yet and should spend more time on that week before moving forward.

The final bullet ("start with classic problems, understand the patterns, gradually tackle complex variants") is the sequencing principle. Never jump to a hard variant (e.g., burst balloons) before mastering the simpler pattern it generalizes from (standard interval DP). The hard variants are hard precisely because they require combining the template with a non-obvious insight, and you cannot recognize the insight if you do not know the template deeply.

### Senior @ FAANG: Summary as a Mentorship and Career Progression Tool

The six dimensions described in the senior section of this summary (property identification, approach selection, state design, space optimization, pattern breadth, application breadth) define the progression from L4 to L7 in DP competency. L4 engineers master dimensions 1-2. L5 engineers master dimensions 1-4. L6 engineers master all six. L7 engineers can extend the framework to novel problem types and teach it to others.

For engineers who manage direct reports, these dimensions provide a concrete vocabulary for career growth conversations. "Your DP property identification is strong but your state design for novel problems needs work" is more actionable than "you need to get better at algorithms." Pairing each dimension with specific LeetCode problem sets (dimension 5 practice: interval DP set, bitmask DP set) makes the growth path concrete and measurable.

The summary's emphasis on pattern recognition as the entry point to application breadth is the key insight for senior coaching: you cannot apply DP patterns to system design problems if you cannot recognize them in the first place. Building pattern recognition through algorithm practice is not a detour from system design, it is a prerequisite for it.
