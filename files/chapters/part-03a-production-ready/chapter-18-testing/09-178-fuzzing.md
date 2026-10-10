## 18.8 Fuzzing

Go 1.18 added native fuzz testing to the standard toolchain. A fuzz test starts with a *seed corpus*, a set of hand-written inputs that exercise known paths, and then the fuzzer mutates those seeds automatically, searching for inputs that trigger panics, assertion failures, or property violations. Unlike table-driven tests, which only check cases you thought of, fuzzing discovers edge cases that would never occur to a human author: malformed UTF-8, deeply nested structures, integer overflow boundaries, and similar surprises.

The fuzz function below verifies a round-trip property: any byte slice that successfully parses as JSON should re-encode to valid JSON that parses back to an identical value. The seed corpus primes the fuzzer with representative inputs, and `f.Fuzz` takes over, generating tens of thousands of mutated variants per second.

The word doing the work in that description is *property*. A fuzz target is only as good as the invariant it asserts, and the most common way to waste one is to generate a million inputs and then check nothing about the output.

```go
func FuzzParseJSON(f *testing.F) {
    // Seed corpus. Every seed must actually reach the property,
    // otherwise it is decoration. See the note below about `[]`.
    f.Add([]byte(`{"name": "Alice"}`))
    f.Add([]byte(`{"name": "Bob", "age": 30}`))
    f.Add([]byte(`{"a": [1, 2, {"b": null}]}`))

    f.Fuzz(func(t *testing.T, data []byte) {
        var result map[string]any
        if err := json.Unmarshal(data, &result); err != nil {
            return // Invalid JSON is not interesting here.
        }

        encoded, err := json.Marshal(result)
        if err != nil {
            t.Fatalf("re-encode failed: %v", err)
        }

        var result2 map[string]any
        if err := json.Unmarshal(encoded, &result2); err != nil {
            t.Fatalf("decode of re-encoded failed: %v", err)
        }

        // THE PROPERTY. Without this comparison the test asserts nothing
        // beyond "no error", and the whole round-trip claim is untested.
        if !reflect.DeepEqual(result, result2) {
            t.Errorf("round-trip mismatch:\n in: %#v\nout: %#v", result, result2)
        }
    })
}
```

Two things here are easy to get wrong, and both make a fuzz target look useful while testing very little.

**State the property, do not merely reach it.** It is tempting to decode into `result2` and stop, because the code "exercises the round trip". It does not *test* it. Without the `reflect.DeepEqual` line, the only assertions are that `Marshal` and `Unmarshal` return no error, so a JSON encoder that dropped every key or silently corrupted values would sail through. A fuzz target with no property is an expensive way to check for panics.

**Every seed must actually reach the property.** The seed `[]` looks like a sensible edge case, and it is dead weight here: it is a JSON array, and the target unmarshals into `map[string]any`, so it fails on the first line and returns before reaching anything:

```
Unmarshal(`[]`, &map) -> json: cannot unmarshal array into Go value of type map[string]interface{}
=> the `[]` seed hits the early return; it exercises nothing
```

It costs nothing and teaches nothing, and worse, it makes the corpus look broader than it is. Replace it with a seed that reaches the property and covers structure the others do not, such as nesting, arrays, and `null`.

For the record, this property does hold. Fuzzing the corrected target for 25 seconds ran about 540,000 executions and found no counterexample:

```
fuzz: elapsed: 24s, execs: 522333 (19988/sec), new interesting: 206 (total: 209)
PASS
```

That is what a healthy fuzz run looks like: high exec rate, "interesting" inputs still trickling in as the fuzzer discovers new coverage, and no crashers.

To run the fuzzer, pass `-fuzz` with a regexp matching the fuzz function name and `-fuzztime` to limit execution duration. Without a time limit, the fuzzer runs indefinitely. Any input that triggers a failure is saved to `testdata/fuzz/<FuncName>/` and replayed automatically on subsequent `go test` runs, becoming a permanent regression test.

```bash
go test -fuzz=FuzzParseJSON -fuzztime=30s
```

**The `-fuzz` regexp must resolve to exactly one target.** Unlike `-run`, it will not fuzz a set. If your package has `FuzzParseJSON_Fixed` and `FuzzParseJSON_BookVersion`, the command above refuses to start:

```
testing: will not fuzz, -fuzz matches more than one fuzz test: [FuzzParseJSON_BookVersion FuzzParseJSON_Fixed]
```

Anchor the pattern (`-fuzz='^FuzzParseJSON$'`) when names share a prefix. It is also worth pairing with `-run=XXX`, since `-fuzz` still runs the package's ordinary tests first, and you usually just want the fuzzer.

**Know where the corpus lives, because there are two of them.** Failing inputs are written to `testdata/fuzz/<FuncName>/` in your repository, and those you commit: they are regression tests. But the much larger corpus of "interesting" inputs the fuzzer accumulates while exploring coverage goes to the build cache:

```
$ ls $(go env GOCACHE)/fuzz/<module>
FuzzParseJSON_Fixed
```

That corpus is not in your repo, is not shared with teammates, and evaporates on `go clean -cache` or on a fresh CI runner. This is the practical catch behind "run fuzzing in CI": a 30-second fuzz run on an ephemeral runner starts from the seed corpus every single time and re-explores the same shallow ground, which is why short CI fuzz runs are a smoke test rather than a real search. Getting value from continuous fuzzing means persisting that cache between runs, or using infrastructure built for it.

### Staff Lens: Fuzz Every Parser

Any function that accepts untrusted bytes is a candidate for a fuzz target. Parsers, deserializers, validators, URL handlers, config loaders. The cost is a one-time fuzz target. The benefit is catching edge-case bugs the test author did not think of.

The discipline: every new parser gets a fuzz target as a PR requirement, and every fuzz target asserts a property rather than just absence of panics. Run it in CI for a bounded time, but treat that bounded run as a regression check over the committed `testdata/fuzz` corpus rather than as genuine exploration, for the cache reason above. Real discovery comes from long runs with a persistent corpus. Teams that adopt this catch parser bugs before they become CVEs.

### Continuous Fuzzing

For high-value targets (parsers in security-sensitive paths), run continuous fuzzing (OSS-Fuzz for open source, similar setups for internal code). Hours of fuzzing per week finds bugs that manual review misses. Major Go projects (the Go stdlib, common parsers) already participate in OSS-Fuzz. Consider it for your critical parsers.

---
