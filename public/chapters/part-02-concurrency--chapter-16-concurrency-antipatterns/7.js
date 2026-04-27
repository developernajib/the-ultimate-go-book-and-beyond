export default `## 16.6 Closure Capture Bugs

### Loop Variable Capture (Pre-Go 1.22)

Before Go 1.22, the loop variable \`i\` was a single variable reused across all iterations. Goroutines that captured it by reference rather than by value would all read the final value of \`i\` once the loop completed. The fix is to either shadow the variable with a new declaration inside the loop body or pass it as a function argument to force a copy at the point of goroutine creation.

\`\`\`go
// BUG (before Go 1.22)
for i := 0; i < 5; i++ {
    go func() {
        fmt.Println(i)  // All print 5!
    }()
}
\`\`\`

**Fix (explicit copy):**
\`\`\`go
for i := 0; i < 5; i++ {
    i := i  // Shadow with new variable
    go func() {
        fmt.Println(i)
    }()
}

// Or pass as parameter
for i := 0; i < 5; i++ {
    go func(n int) {
        fmt.Println(n)
    }(i)
}
\`\`\`

**Go 1.22+ fixes this automatically.**

### Range Variable Capture (Pre-Go 1.22)

The same single-variable semantics apply to \`range\` loops: \`v\` is overwritten on each iteration, so goroutines that close over it will all see the last element of the slice when they finally execute. Go 1.22 changed loop variable semantics so each iteration gets its own copy, eliminating this class of bug without requiring code changes.

\`\`\`go
// BUG (before Go 1.22)
for _, v := range values {
    go func() {
        process(v)  // All process the last value!
    }()
}
\`\`\`

### Go 1.22+ Changes the Rules

Go 1.22 made each loop iteration get its own variable. Code that relied on the old shared-variable behaviour silently changes meaning when upgraded. For codebases straddling the 1.22 boundary, check \`go.mod\` to know which semantics apply. Newer code does not need the \`v := v\` shadow trick; older code does.

The staff-level discipline during migration: audit all goroutine-spawning loops when the \`go\` directive is bumped to 1.22 or later. Usually nothing breaks because the fix (shadow variable) now happens automatically. Rarely, code depended on the old behaviour and needs explicit revision.

---
`;
