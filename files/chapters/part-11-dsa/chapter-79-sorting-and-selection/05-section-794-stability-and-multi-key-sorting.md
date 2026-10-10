## 79.4 Stability and Multi-Key Sorting

Stability is the property engineers ignore until it produces a bug they cannot reproduce. It deserves its own section because it is the one sorting concept that regularly causes production incidents.

### The Contract

A stable sort preserves the relative order of elements that compare equal. Consider sorting employees by department:

```go
type Employee struct {
    Name string
    Dept string
}

people := []Employee{
    {"Ada", "Eng"},
    {"Bo", "Sales"},
    {"Cy", "Eng"},
}
```

Sort by `Dept` with a stable sort and Ada always precedes Cy, because she did originally. Sort with an unstable sort and the order of Ada and Cy is unspecified. It might be stable today, for this input length, on this Go version, and change tomorrow. Go's `slices.Sort` and `sort.Slice` are unstable, and pdqsort's insertion-sort path for short slices means small inputs often *look* stable. That is the trap: the bug hides until a slice grows past 12 elements in production.

```go
slices.SortFunc(people, func(a, b Employee) int {
    return strings.Compare(a.Dept, b.Dept)
})
// Ada before Cy? Unspecified. Do not rely on it.

slices.SortStableFunc(people, func(a, b Employee) int {
    return strings.Compare(a.Dept, b.Dept)
})
// Ada before Cy? Guaranteed.
```

### Two Ways to Sort by Multiple Keys

Say you want employees ordered by department, and within a department by name.

**Approach 1: repeated stable passes, least significant key first.**

```go
// Sort by the secondary key first, then stably by the primary key.
slices.SortStableFunc(people, func(a, b Employee) int {
    return strings.Compare(a.Name, b.Name)
})
slices.SortStableFunc(people, func(a, b Employee) int {
    return strings.Compare(a.Dept, b.Dept)
})
```

This works precisely because the second sort is stable: it reorders by department while preserving the name order established by the first pass. Reverse the order of the two calls and it is wrong. Make either sort unstable and it is wrong. This is the technique radix sort is built on, and it is the reason stability exists as a concept at all.

**Approach 2: one comparison function with explicit tie-breaking.**

```go
slices.SortFunc(people, func(a, b Employee) int {
    if c := strings.Compare(a.Dept, b.Dept); c != 0 {
        return c
    }
    return strings.Compare(a.Name, b.Name)
})
```

**Prefer approach 2 in Go.** It is one pass instead of two, it can use the faster unstable sort because the comparison function is a total order with no ties left to preserve, and, most importantly, it states the intent in the code. A reader of approach 1 must know the stable-passes idiom and notice that the call order is load-bearing. A reader of approach 2 sees the tie-break rule written down.

Approach 1 earns its place in exactly one situation: when you cannot write a single comparison, because the keys arrive at different times or the sorts happen in different layers of the system.

### The Deterministic-Output Rule

If a sort's output is user-visible, serialized, hashed, cached, or compared against a golden file, it must be a **total order**. An unstable sort with ties produces output that can differ between runs, versions, or input lengths, and every one of those is a source of flaky tests and confusing diffs.

The fix is not "use a stable sort." It is to break the tie explicitly, usually on a unique field:

```go
// Deterministic regardless of the sort's stability.
slices.SortFunc(rows, func(a, b Row) int {
    if c := cmp.Compare(b.Score, a.Score); c != 0 {
        return c // primary: score descending
    }
    return cmp.Compare(a.ID, b.ID) // tie-break: stable, unique, total
})
```

Now the ordering is a function of the data alone. It does not depend on the sort algorithm, the input order, or the Go version. That property is worth the one extra line every time.

### Junior -> FAANG: The Question Behind the Question

When an interviewer says "sort these records by date," the follow-up is often "what happens to two records with the same date?" They are testing whether you know that the answer is "unspecified, unless I choose a stable sort or break the tie."

The strongest answer names the trade-off: "`slices.Sort` is unstable, so ties are arbitrary. If the tie order matters I would either use `slices.SortStableFunc`, or better, add a tie-breaker to the comparison so the ordering is total and I do not depend on the sort's stability at all."

The reflex to build: whenever you write a comparison function, ask "can two distinct elements compare equal here?" If yes, decide deliberately what happens to them. Do not let the algorithm decide.

### Senior @ FAANG: Stability as an API Boundary

The subtle organizational failure is that stability is a property of the *implementation* that leaks into the *contract*. A function returning a sorted slice has a stability guarantee whether or not its doc comment mentions one, because callers will observe the behavior and depend on it. This is Hyrum's Law applied to sorting: with enough callers, every observable behavior of your system is depended on by somebody.

The mitigation is to make it explicit at the boundary. If a public API returns ordered results, document the total order including tie-breaks, and make the implementation match the documentation rather than the reverse. If the order genuinely is not guaranteed, say so, and consider actively shuffling ties in test builds to break callers who depend on an order you never promised. Go does exactly this with map iteration, and it is why Go programs do not have the "worked until we upgraded" class of bug that plagues languages with incidentally-ordered maps.

For code review: a `SortStableFunc` call whose comparison already produces a total order is a signal. Either the author did not realize the tie-break made stability redundant, in which case they are paying for a slower sort for nothing, or the comparison does have ties and the stability is load-bearing but undocumented. Both are worth a comment.
