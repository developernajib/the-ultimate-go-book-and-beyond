## 16.6 Closure Capture Bugs

### Loop Variable Capture (Pre-Go 1.22)

Before Go 1.22, the loop variable `i` was a single variable reused across all iterations. Goroutines that captured it by reference rather than by value would all read the final value of `i` once the loop completed. The fix is to either shadow the variable with a new declaration inside the loop body or pass it as a function argument to force a copy at the point of goroutine creation.

```go
// BUG (before Go 1.22)
for i := 0; i < 5; i++ {
    go func() {
        fmt.Println(i)  // All print 5!
    }()
}
```

**Fix (explicit copy):**
```go
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
```

**Go 1.22+ fixes this automatically**, for modules whose `go.mod` declares `go 1.22` or later. See below: the toolchain version is not what decides.

Note what 1.22 did *not* fix. Only the **loop variable** became per-iteration. Any other variable declared outside the loop is still shared by every closure, and that hazard is unchanged:

```go
// STILL A BUG in every Go version: err is declared outside the loop
var err error
for _, item := range items {
    go func() {
        err = process(item) // Data race: all goroutines write the same err
    }()
}
```

Loop-variable capture stopped being the common bug. Capturing shared accumulators like this did not.

### Range Variable Capture (Pre-Go 1.22)

The same single-variable semantics apply to `range` loops: `v` is overwritten on each iteration, so goroutines that close over it will all see the last element of the slice when they finally execute. Go 1.22 changed loop variable semantics so each iteration gets its own copy, eliminating this class of bug without requiring code changes.

```go
// BUG (before Go 1.22)
for _, v := range values {
    go func() {
        process(v)  // All process the last value!
    }()
}
```

### Go 1.22+ Changes the Rules

Go 1.22 made each loop iteration get its own variable. The critical detail, and the one that surprises people, is **what selects the behaviour**: it is the `go` directive in `go.mod`, not the toolchain you have installed. A Go 1.27 toolchain compiling a module that declares `go 1.21` still uses the old shared-variable semantics.

That is worth seeing, because it means "I'm on a modern Go" is not the answer to "do I have this bug?". The same program, the same compiler, two `go.mod` files:

```
// go.mod says: go 1.21
captured values: [5 5 5 5 5]      <- old semantics, the classic bug

// go.mod says: go 1.22
captured values: [0 1 2 3 4]      <- per-iteration variable
```

So the question to ask about any file is not which Go is installed, it is what its module declares. `go vet`'s `loopclosure` check follows the same rule: it reports `loop variable i captured by func literal` for a `go 1.21` module and stays silent for `go 1.22`, so vet tells you the truth about the code in front of you.

Newer code does not need the `v := v` shadow. Older code does. The shadow remains harmless in new code, which is why the idiom lingers in codebases long after it stopped being necessary. Leave it alone rather than churning it out, and let vet be the arbiter.

The staff-level discipline during migration: audit goroutine-spawning loops when the `go` directive is bumped to 1.22 or later. Usually nothing breaks, because the fix now happens automatically. Rarely, code depended on the old aliasing, most often accumulating into a captured variable on purpose, and that code changes meaning silently. Bumping the directive is a semantic change, so give it its own commit rather than burying it in a dependency update.

---
