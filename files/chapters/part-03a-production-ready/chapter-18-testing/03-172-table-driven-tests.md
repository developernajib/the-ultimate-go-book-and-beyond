## 18.2 Table-Driven Tests

Table-driven tests are Go's dominant testing pattern. Instead of writing a separate function for each scenario, you declare test cases as entries in a slice of anonymous structs, then iterate over them with `t.Run`. This separates test data from test logic: adding a new scenario means appending one struct literal rather than copying and modifying an entire function. The pattern also produces named subtests, so `go test -v` output and failure messages identify exactly which case broke.

Here is a typical table-driven test for a `Divide` function that must handle both normal arithmetic and division-by-zero errors:

```go
func TestDivide(t *testing.T) {
    tests := []struct {
        name      string
        a, b      float64
        want      float64
        wantErr   bool
    }{
        {
            name: "positive numbers",
            a:    10,
            b:    2,
            want: 5,
        },
        {
            name: "negative dividend",
            a:    -10,
            b:    2,
            want: -5,
        },
        {
            name:    "division by zero",
            a:       10,
            b:       0,
            wantErr: true,
        },
        {
            name: "decimal result",
            a:    7,
            b:    2,
            want: 3.5,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := Divide(tt.a, tt.b)

            if tt.wantErr {
                if err == nil {
                    t.Error("expected error, got nil")
                }
                return
            }

            if err != nil {
                t.Errorf("unexpected error: %v", err)
                return
            }

            if got != tt.want {
                t.Errorf("Divide(%v, %v) = %v; want %v",
                    tt.a, tt.b, got, tt.want)
            }
        })
    }
}
```

### Benefits of Table-Driven Tests

Table-driven tests offer several concrete advantages over flat, one-function-per-case testing:

1. **Easy to extend.** Adding a new scenario is a single struct literal with no additional control flow
2. **Consistent logic.** Every case exercises the same code path through the loop body, so a bug in assertion logic affects all cases equally and is obvious
3. **Self-documenting.** The `name` field serves as living documentation of expected behavior. `go test -v` prints these names alongside pass/fail
4. **Less duplication.** Setup, execution, and assertion logic appear once rather than being copied across dozens of test functions
5. **Targeted reruns.** Because each case becomes a subtest via `t.Run`, you can rerun a single failing case with `go test -run TestDivide/division_by_zero`

### Staff Lens: Table Tests as Living Specifications

A well-structured table-driven test is the best documentation of a function's contract. The `name` field describes behavior. The inputs and expected outputs show exactly what happens in each case. Reviewers can see coverage at a glance. New engineers understand behavior by reading the tests.

The discipline: name test cases descriptively ("returns ErrNotFound when user does not exist", not "test case 3"). Include error-path cases alongside happy paths. Add a case for every bug fixed in the underlying function. Over time, the test becomes institutional memory.

### Go 1.22+ Loop Variable

Since Go 1.22, loop variables are per-iteration, so the `tt := tt` shadow that older table tests carry is no longer needed for `t.Parallel()` to capture the right case. Modern code can drop it.

The detail that matters, and that trips people up, is **what selects the behavior**. It is not the toolchain you have installed, it is the `go` directive in your `go.mod`. The same test, same Go 1.26 toolchain, recording which case each parallel subtest actually captured:

```
// go.mod says: go 1.24
each parallel subtest captured its OWN tt: map[a:a b:b c:c] (len=3)

// go.mod says: go 1.21
each parallel subtest captured its OWN tt: map[c:c] (len=1)
```

Under `go 1.21`, all three subtests closed over the same variable and every one of them saw the final case. Note what did *not* happen: **the tests still passed**. Each subtest checked the case it captured, and the case it captured was internally consistent, so nothing failed. It just silently tested `c` three times and never tested `a` or `b` at all.

That is the shape of this bug in the wild. It does not announce itself with a failure, it quietly deletes coverage. So if you maintain a module whose `go.mod` still declares a pre-1.22 version, the shadow is still load-bearing and removing it is a real regression. Bumping the directive is what actually retires it.

---
