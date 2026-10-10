## 69.12 Exercises with Solutions

### Exercise 1: First Unique Character

Find the first non-repeating character in a string.

```go
// Solution
func firstUniqChar(s string) int {
    count := make(map[rune]int)

    // Count occurrences
    for _, c := range s {
        count[c]++
    }

    // Find first unique
    for i, c := range s {
        if count[c] == 1 {
            return i
        }
    }

    return -1
}

// Optimized: Single pass with position tracking
func firstUniqCharOptimized(s string) int {
    type charInfo struct {
        count int
        first int
    }

    info := make(map[rune]*charInfo)

    for i, c := range s {
        if info[c] == nil {
            info[c] = &charInfo{count: 1, first: i}
        } else {
            info[c].count++
        }
    }

    minIdx := len(s)
    for _, ci := range info {
        if ci.count == 1 && ci.first < minIdx {
            minIdx = ci.first
        }
    }

    if minIdx == len(s) {
        return -1
    }
    return minIdx
}
```

### Exercise 2: Isomorphic Strings

Check if two strings are isomorphic.

```go
import "testing"

// Solution
func isIsomorphic(s string, t string) bool {
    if len(s) != len(t) {
        return false
    }

    sToT := make(map[byte]byte)
    tToS := make(map[byte]byte)

    for i := 0; i < len(s); i++ {
        sc, tc := s[i], t[i]

        // Check s -> t mapping
        if mapped, exists := sToT[sc]; exists {
            if mapped != tc {
                return false
            }
        } else {
            sToT[sc] = tc
        }

        // Check t -> s mapping (bijection)
        if mapped, exists := tToS[tc]; exists {
            if mapped != sc {
                return false
            }
        } else {
            tToS[tc] = sc
        }
    }

    return true
}

// Test
func TestIsIsomorphic(t *testing.T) {
    tests := []struct {
        s, t     string
        expected bool
    }{
        {"egg", "add", true},
        {"foo", "bar", false},   // forward conflict: sToT alone catches this
        {"paper", "title", true},
        {"badc", "baba", false}, // reverse conflict: only tToS catches this
        {"ab", "aa", false},     // smallest case that needs the reverse map
    }

    for _, tt := range tests {
        got := isIsomorphic(tt.s, tt.t)
        if got != tt.expected {
            t.Errorf("isIsomorphic(%q, %q) = %v, want %v",
                tt.s, tt.t, got, tt.expected)
        }
    }
}
```

### Junior -> FAANG: What These Solutions Teach About Interview Code Quality

The `firstUniqChar` two-pass solution is clean and obvious. The `firstUniqCharOptimized` single-pass version is a good example of what "optimized" means in an interview: it trades code clarity for a single linear pass by tracking both count and first position simultaneously. Interviewers generally prefer the two-pass version unless they explicitly ask you to optimize. Writing unnecessarily complex code to show off is a red flag.

The isomorphic strings bidirectional map (`sToT` and `tToS`) is a classic bijection enforcement pattern. Be careful about which test case actually justifies the reverse map, because it is easy to pick the wrong one. "foo" versus "bar" is *not* the motivating case: `sToT` alone already rejects it, since `o` maps to `a` and then the second `o` demands `r`, and one map catches the conflict.

The case that requires `tToS` is `"badc"` versus `"baba"` in the table above, and the smallest example is `"ab"` versus `"aa"`. Here `sToT` records `a->a` and `b->a` with no conflict at all, because forward mapping never notices that two distinct source characters collapsed onto the same target. Only `tToS` catches it: `a` is already claimed by `a`, so `b` cannot claim it too. A one-way map enforces a *function*, and the problem asks for a *bijection*. The general lesson generalizes well past this problem: a mapping is only one-to-one if you enforce uniqueness in both directions, and a test suite that only contains forward conflicts will pass a broken implementation.

The included test function shows the correct pattern for table-driven tests in Go. Always write tests this way in interviews that ask you to test your solution: a `tests` slice of structs, a range loop, and `t.Errorf` with a descriptive message that includes all inputs and the actual vs expected values.

### Senior @ FAANG: Solution Quality and the Art of Code Review

The optimized first-unique-character solution has a subtle issue: iterating over a `map[rune]*charInfo` to find the minimum first-seen index is O(n) in the number of distinct characters, and the iteration order is non-deterministic. The solution is correct because it scans all entries and tracks `minIdx`, but the non-deterministic iteration makes it harder to reason about and test. A cleaner alternative is the two-pass array approach with a `[26]int` for ASCII strings, which is O(n) time and O(1) space with deterministic iteration.

A senior code review of the isomorphic strings solution would note that it uses `byte` as the map key type, which is correct for ASCII-only strings but silently fails for Unicode strings where a single "character" is a multi-byte rune. The function signature should either document the ASCII-only constraint explicitly or use `rune` as the key type to handle Unicode correctly. Silent ASCII assumptions in string-processing code are a recurring source of internationalization bugs in production systems.

---
