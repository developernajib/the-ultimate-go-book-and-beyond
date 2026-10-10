## 80.9 Common Mistakes to Avoid

Awareness of common interview mistakes prevents candidates from losing evaluations to avoidable procedural errors rather than genuine knowledge gaps. The following examples contrast the mistake with the corrected behavior, illustrating why each error is penalized and what the corrected approach demonstrates to the interviewer.

```go
// 1. Forgetting to handle errors
resp, err := http.Get(url)
// WRONG: if err != nil alone
// RIGHT: Always handle the error case

// 2. Goroutine variable capture
for i := 0; i < 10; i++ {
    go func() {
        fmt.Println(i)  // WRONG: captures i, prints 10 ten times
    }()
}
// RIGHT: Pass as parameter
for i := 0; i < 10; i++ {
    go func(n int) {
        fmt.Println(n)  // Correct
    }(i)
}
// Or use Go 1.22+ loop variable semantics

// 3. Nil map assignment
var m map[string]int
// m["key"] = 1  // PANIC!
m = make(map[string]int)
m["key"] = 1  // OK

// 4. Modifying slice while iterating
nums := []int{1, 2, 3, 4, 5}
for i, n := range nums {
    if n%2 == 0 {
        // WRONG: nums = append(nums[:i], nums[i+1:]...)
    }
}
// RIGHT: Filter to new slice or iterate backwards

// 5. Ignoring context cancellation
func process(ctx context.Context) error {
    for {
        // WRONG: infinite loop ignoring context
        doWork()
    }
}
// RIGHT:
func process(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            doWork()
        }
    }
}
```

---

### Junior → FAANG: Turning Mistake Awareness into Mistake Prevention

Reading a list of common interview mistakes is insufficient for prevention. You need to observe yourself making each mistake during practice before you can reliably avoid it in the real setting. For each mistake in this section, deliberately trigger it in a mock session by coding too fast, skipping the clarification step, or not testing before claiming correctness. Experiencing the consequence during practice (catching the bug yourself, or having a practice partner catch it) creates stronger behavioral change than reading about it.

The three highest-impact mistakes for junior candidates: jumping to code before clarifying constraints (solvable by forcing a mandatory 3-minute clarification phase before touching the keyboard), claiming a solution is correct without testing it (solvable by always tracing through the smallest example by hand), and silent freezing when stuck (solvable by practicing the verbal pivot: "I am not immediately seeing the optimal approach, so let me start with the brute-force solution and refine from there").

First-job insight: these same mistakes appear in production code reviews. The engineer who commits code without edge-case consideration, or who ships a solution without testing the boundary conditions, is applying the same habits that fail in interviews. Interview discipline and production discipline reinforce each other.

### Senior @ FAANG: Senior Mistakes Are Subtler and More Consequential

Senior-level mistakes in interviews are not "forgot to check for nil" level. They are reasoning errors that reveal a gap in judgment that would affect production systems. The most common senior mistakes: over-engineering (proposing a distributed system when the problem fits in a single process), under-specifying trade-offs (saying "I would use Kafka" without explaining why or what alternative was rejected), and missing the organizational dimension of a system design (a technically correct design that ignores operational complexity is not a senior-level answer).

The "over-engineering" mistake deserves particular attention. At FAANG scale, engineers are penalized for proposing complex solutions to simple problems because complexity has a real cost: more code to maintain, more failure modes to handle, more onboarding burden for future team members. An L6 candidate knows that simplicity is a feature and can defend a simple design against a complex alternative.

Bar-raiser signal for avoiding mistakes: demonstrate mistake prevention as a system rather than individual vigilance. "I always clarify constraints first because I have had two production incidents where unstated assumptions about input size invalidated the design" is a senior answer. It shows that you have turned past failures into durable process improvements, which is exactly what FAANG wants from senior engineers making decisions that affect entire platform layers.
