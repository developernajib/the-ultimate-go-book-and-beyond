# Chapter 74: Backtracking

> *"The art of backtracking is knowing not just how to go forward, but exactly when and how to turn back."*
> - Anonymous

Backtracking is the algorithmic embodiment of disciplined exploration. Where brute force exhausts every possibility blindly, backtracking prunes the search space by abandoning a path the moment it is determined to be incapable of yielding a valid solution. This constraint-driven exploration makes backtracking the go-to technique for combinatorial problems (permutations, combinations, subsets, constraint satisfaction puzzles, and board games) where the solution space is vast but heavily constrained. Understanding backtracking deeply means understanding when to recurse deeper, when to prune, and how to restore state cleanly on the way back up the call stack.

In Go, backtracking is clean to express. Slice append semantics, combined with explicit truncation (`path = path[:len(path)-1]`), give a natural mechanism for the "choose, explore, unchoose" pattern that defines the template. Go has no built-in set type, so you will practice tracking visited state with `map[int]bool` or in-place array manipulation, which is a skill interviewers notice.

Go also has a trap here that other languages hide, and this chapter will keep returning to it. Because a slice is a view onto a backing array rather than a value, `append` may write through to memory another slice header still points at. That makes the aliasing bug in the next section a Go bug specifically, not a generic backtracking bug. Nothing about Go's type system saves you from it, and the compiler will never mention it.

This chapter covers the complete backtracking toolkit: the universal template, subset generation, permutation generation (with and without duplicates), combination sum variants, constraint satisfaction (N-Queens, Sudoku solver, word search), and graph-based backtracking (Hamiltonian paths, knight's tour). Each problem is analyzed for its search tree structure, meaning branching factor, depth, and pruning effectiveness, so you can estimate time complexity and communicate it confidently. You will also study the distinction between backtracking and dynamic programming, since many problems can be approached with either technique and choosing wisely is itself an interview signal.

**What you'll learn in this chapter:**

- The universal backtracking template in Go: `choose → recurse → unchoose` with slice state management
- Generating all subsets and power sets with and without duplicate elements using sort-and-skip pruning
- Generating all permutations iteratively and recursively with O(n!) complexity awareness
- Solving combination sum I and II, letter combinations, palindrome partitioning
- Implementing N-Queens and Sudoku Solver with column, row, and diagonal constraint tracking
- Performing word search on a 2D grid with in-place visited marking and restoration
- Recognizing when to switch from backtracking to DP based on overlapping subproblem presence
- Analyzing branching factor and pruning effectiveness to estimate and communicate complexity

**Why this matters in interviews:**

Backtracking is a phone-screen staple, and it usually arrives wearing the phrase "generate all..." or "find all valid...". It is favored for a reason: the problems are compact enough to fit in 45 minutes, the correct approach is non-obvious to anyone who has not internalized the template, and the state management exposes whether a candidate actually understands recursion or has only memorized its shape. In Go specifically, the thing being watched is slice state management, because a candidate who shares slice state between recursive calls produces output that looks structurally correct and is entirely wrong. This chapter drills that discipline until it is automatic.

**Prerequisites:** Chapter 65 (Complexity Analysis), Chapter 66 (Arrays and Strings), Chapter 72 (Graphs, for the graph backtracking variants), solid comfort with Go slice operations and recursive call stacks.

---

### Junior → FAANG: Why Backtracking Trips Up Junior Candidates

Backtracking failures in interviews almost always come from one of three sources: not recognizing that the problem requires backtracking, writing the backtrack step incorrectly (forgetting to undo the choice), or sharing slice state between recursive calls by appending without copying.

The recognition problem: backtracking problems are identified by the phrase "find all," "generate all," or "return all valid." If the problem asks for one answer, greedy or DP is likely better. If it asks for all answers or counts all arrangements, backtracking is the right lens.

The backtrack step problem: the template is "make choice, recurse, unmake choice." Every candidate knows the first two steps. The third step is the one that gets forgotten under pressure. In Go, for a slice-based path, the unmake step is `path = path[:len(path)-1]`. Forgetting this leaves the path in a modified state and produces wrong results.

The slice-sharing problem: when you collect `path` into the result, you must copy it. `result = append(result, path)` stores a reference to the same underlying array. Subsequent modifications to `path` will corrupt already-stored results. The correct form is `result = append(result, append([]int{}, path...))` or using `copy` into a new slice.

### Senior @ FAANG: Backtracking as a Platform and System Design Lens

Senior engineers encounter backtracking not just in algorithm interviews but in system design contexts. Configuration validation (does this set of configuration options satisfy all constraints?), feature flag combination testing (which combinations of feature flags produce valid system states?), and dependency resolution (which package versions satisfy all version constraints simultaneously?) are all constraint satisfaction problems amenable to backtracking.

At the platform level, backtracking's exponential worst-case complexity is the central concern. Systems that expose backtracking-based algorithms to external input must bound the search space rigorously. A SAT solver, for example, is a generalized backtracking engine. Without careful heuristics (variable ordering, unit propagation, conflict-driven clause learning), it is unusable for real-world inputs. Staff engineers who understand backtracking deeply can evaluate when a problem's structure allows effective pruning (making it tractable) versus when the search space is effectively unbounded (requiring a shift to approximation or sampling).

Governance consideration: any production system that uses backtracking should have an explicit depth limit or time limit enforced as a hard constraint, with graceful degradation (return the best partial result found so far) when the limit is exceeded. Documenting this limit in the ADR and configuring it via environment variable (rather than hardcoding) allows adjustment based on production workload observations without a code change.

### Junior → FAANG: Why Backtracking Is a Distinct Skill

Many candidates who are comfortable with recursion still struggle with backtracking because they treat it as "recursion with a loop" rather than "recursion with state restoration." The critical difference is the undo step. In plain recursion, you compute and return. In backtracking, you modify shared state, recurse, then undo the modification. The undo step is not optional: without it, the shared state accumulates changes from all previous recursive calls and the algorithm explores a corrupted state space.

The Go-specific version of this problem is slice aliasing, and it is worth tracing exactly, because the usual one-line summary is wrong about the mechanism and therefore easy to dismiss.

A slice is a header (pointer, length, capacity) pointing at a backing array. When you write `path = append(path, x)`, Go reuses the existing array if capacity allows and allocates a fresh one if it does not. So whether the parent and child share memory depends on capacity, which means the bug is capacity-dependent and can hide during testing on small inputs.

Now suppose you store the path with `result = append(result, path)`. That copies the *header*, not the data. Both `result[0]` and `path` now point at the same array. Truncating with `path = path[:len(path)-1]` does not corrupt anything yet: it only shortens `path`'s length, and `result[0]` still reads `[1 2]` because the array is untouched. The damage lands on the *next* append, which writes a new value into the slot the stored result is still reading. `result[0]` becomes `[1 99]` without a single line of code touching `result`.

The full-blown symptom is a result set where every entry is identical, or entries that are the right length and complete nonsense. Nothing panics, the count is right, and the shapes are right. Only the contents are wrong. This is the bug that kills most first-attempt backtracking solutions in Go, and the fix is one deep copy at the moment of collection: `append([]int(nil), path...)`.

### Senior @ FAANG: Backtracking System Design at Scale

At the platform level, backtracking-based systems require three architectural safeguards that go beyond algorithmic correctness. First, bounded execution time: the search must be interruptible. Implement a context-aware loop that checks `ctx.Err()` at the top of each recursive call and returns the best result found so far when the context is canceled. This prevents backtracking searches from holding goroutines indefinitely when a client times out.

Second, state isolation per request: if the backtracking function is called from concurrent goroutines (as it would be in a web service), all mutable state (path, visited arrays, constraint sets) must be goroutine-local. Never share a constraint data structure between concurrent backtracking searches. The initialization cost of per-request state is always smaller than the cost of a data race.

Third, input-driven depth limits: for user-controlled inputs (n in N-Queens, board size in Sudoku), validate and cap the input before starting the search. Document the cap with a comment that explains the maximum input size that produces results within the latency budget on the target hardware. Update this comment when the hardware changes.
