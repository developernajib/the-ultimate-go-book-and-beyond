## 68.13 Exercises with Solutions

### Exercise 1: Asteroid Collision

Given an array of asteroids with size and direction (positive=right, negative=left), determine which survive after all collisions.

```go
// Solution: Stack simulation
func asteroidCollision(asteroids []int) []int {
    stack := []int{}

    for _, asteroid := range asteroids {
        alive := true

        // Check for collisions with right-moving asteroids
        for alive && asteroid < 0 && len(stack) > 0 && stack[len(stack)-1] > 0 {
            // Left-moving meets right-moving
            if stack[len(stack)-1] < -asteroid {
                // Incoming asteroid destroys stack top
                stack = stack[:len(stack)-1]
            } else if stack[len(stack)-1] == -asteroid {
                // Both destroyed
                stack = stack[:len(stack)-1]
                alive = false
            } else {
                // Stack top destroys incoming
                alive = false
            }
        }

        if alive {
            stack = append(stack, asteroid)
        }
    }

    return stack
}

// Test
func TestAsteroidCollision(t *testing.T) {
    tests := []struct {
        input    []int
        expected []int
    }{
        {[]int{5, 10, -5}, []int{5, 10}},
        {[]int{8, -8}, []int{}},
        {[]int{10, 2, -5}, []int{10}},
        {[]int{-2, -1, 1, 2}, []int{-2, -1, 1, 2}},
    }

    for _, tt := range tests {
        got := asteroidCollision(tt.input)
        if !slicesEqual(got, tt.expected) {
            t.Errorf("asteroidCollision(%v) = %v, want %v",
                tt.input, got, tt.expected)
        }
    }
}

func slicesEqual(a, b []int) bool {
    if len(a) != len(b) {
        return false
    }
    for i := range a {
        if a[i] != b[i] {
            return false
        }
    }
    return true
}
```

### Exercise 2: Decode String

Given an encoded string like "3[a2[c]]", decode it to "accaccacc".

```go
import "strings"

// Solution: Two stacks for counts and strings
func decodeString(s string) string {
    countStack := []int{}
    stringStack := []string{}

    currentNum := 0
    currentStr := ""

    for _, c := range s {
        if c >= '0' && c <= '9' {
            currentNum = currentNum*10 + int(c-'0')
        } else if c == '[' {
            // Save current state
            countStack = append(countStack, currentNum)
            stringStack = append(stringStack, currentStr)
            currentNum = 0
            currentStr = ""
        } else if c == ']' {
            // Pop and repeat
            count := countStack[len(countStack)-1]
            countStack = countStack[:len(countStack)-1]
            prevStr := stringStack[len(stringStack)-1]
            stringStack = stringStack[:len(stringStack)-1]

            // strings.Repeat, not a += loop. Go strings are immutable, so
            // `repeated += currentStr` allocates a new string and copies
            // everything on every iteration, making the repeat quadratic in
            // count. strings.Repeat sizes one buffer and fills it once.
            // Decoding "160000[a]" takes about 1.9 seconds with the += loop
            // and under 100 microseconds this way, for identical output.
            currentStr = prevStr + strings.Repeat(currentStr, count)
        } else {
            currentStr += string(c)
        }
    }

    return currentStr
}

// Recursive solution
func decodeStringRecursive(s string) string {
    idx := 0
    return decode(s, &idx)
}

func decode(s string, idx *int) string {
    result := ""

    for *idx < len(s) && s[*idx] != ']' {
        if s[*idx] >= '0' && s[*idx] <= '9' {
            // Parse number
            num := 0
            for *idx < len(s) && s[*idx] >= '0' && s[*idx] <= '9' {
                num = num*10 + int(s[*idx]-'0')
                *idx++
            }
            *idx++ // Skip '['

            // Recursively decode inside brackets
            decoded := decode(s, idx)
            *idx++ // Skip ']'

            // Repeat decoded string (see the note in decodeString: a +=
            // loop here is quadratic in num)
            result += strings.Repeat(decoded, num)
        } else {
            result += string(s[*idx])
            *idx++
        }
    }

    return result
}

// Test
func TestDecodeString(t *testing.T) {
    tests := []struct {
        input    string
        expected string
    }{
        {"3[a]2[bc]", "aaabcbc"},
        {"3[a2[c]]", "accaccacc"},
        {"2[abc]3[cd]ef", "abcabccdcdcdef"},
        {"abc3[cd]xyz", "abccdcdcdxyz"},
    }

    for _, tt := range tests {
        got := decodeString(tt.input)
        if got != tt.expected {
            t.Errorf("decodeString(%q) = %q, want %q",
                tt.input, got, tt.expected)
        }
    }
}
```

### Junior -> FAANG: Solution Analysis and Testing Habits

**Asteroid Collision solution correctness:** The inner `for alive && asteroid < 0 && len(stack) > 0 && stack[top] > 0` loop handles three collision outcomes correctly: top is smaller (pop and continue), top is equal (pop and set alive=false), top is larger (set alive=false only). Verify your solution handles the symmetric case: two asteroids moving in the same direction never collide regardless of their sizes.

**Decode String solution clarity:** The two solutions are structurally equivalent, since the iterative version's two stacks are exactly what the recursive version keeps in its call frames. Prefer the iterative one for the usual reason (explicit state you can bound and inspect), and note the recursive one uses O(nesting depth) stack, which is bounded by the input length and is not the real hazard here.

Both are O(n) in the decoded length *only if the repetition is done right*. With `strings.Repeat` they are. With a `+=` loop they are quadratic in the repeat count, because each `+=` allocates a fresh string and copies the whole accumulated result. That is not a micro-optimization: the difference on `160000[a]` is about 1.9 seconds versus under 100 microseconds. Whenever you build a string in a Go loop, the answer is `strings.Repeat`, `strings.Builder`, or a pre-sized `[]byte`, never `+=`.

**Extending the test suites.** For asteroid collision, add `{input: []int{-1, -2, -3}, expected: []int{-1, -2, -3}}` (all moving left, no collisions) and `{input: []int{1, 2, 3}, expected: []int{1, 2, 3}}` (all moving right, no collisions). For decode string, add `{input: "a", expected: "a"}` (no encoding) and `{input: "10[a]", expected: "aaaaaaaaaa"}` (two-digit count).

**`slicesEqual` utility:** This is the standard comparison helper for slice-valued test outputs. Note that `slicesEqual(nil, []int{})` returns `true` because `len(nil) == 0` and `len([]int{}) == 0`. This is correct behavior for linked list tests that return nil for empty results, but document it explicitly so future test writers understand the equality contract.

### Senior @ FAANG: Exercise Solution Quality as a Production Signal

**Asteroid Collision as a simulation correctness exercise.** The three-condition inner loop (`alive`, `asteroid < 0`, `stack[top] > 0`) is the minimal set of conditions to maintain the invariant "stack contains only right-moving asteroids." Any fewer conditions and the invariant breaks. Any more conditions and the logic becomes over-specified and fragile. In a code review, a senior engineer should verify the invariant explicitly in a comment: "// Invariant: all elements in stack are right-moving asteroids (positive values)." This makes the loop condition self-documenting.

**Decode String: string concatenation as a review trigger.** The naive form of this solution repeats with `repeated += currentStr` in a loop. Because Go strings are immutable, each `+=` allocates a new string and copies the accumulated result, so the loop is O(count^2 * len) rather than the O(count * len) it appears to be. It is the string-building equivalent of the quadratic `append` mistake, and it is invisible on the LeetCode fixtures, where counts are single digits, and catastrophic at scale: 1.9 seconds for `160000[a]` against under 100 microseconds for `strings.Repeat`. This is fixed above. A review of any string-assembling loop should ask the same question, and the remaining `currentStr += string(c)` in the default branch deserves the same scrutiny: it is fine for typical inputs but would become a `strings.Builder` if a literal run could be long. Note that the outer `prevStr + strings.Repeat(...)` is a single concatenation per bracket and does not need building.

**Recursive `decodeStringRecursive` and the index pointer.** The `idx *int` parameter is a shared mutable cursor that advances through the string across recursive calls. This pattern (passing a pointer to an index to share progress across recursive frames) is Go-idiomatic but requires careful documentation: callers must not assume `idx` is unchanged after the call. In a production parser, this pattern should be encapsulated in a `Parser` struct with an unexported `pos` field, making the mutation implicit rather than explicit. A code review should suggest this refactoring for any recursive descent parser that uses the `*int` index pattern.

**Test naming discipline.** The test cases in this section use struct literals without names. For production test suites, name each test case with a string that describes the scenario being tested: `{name: "all left-moving", input: []int{-1, -2}, expected: []int{-1, -2}}`. Named test cases produce better failure messages and make it easier to selectively run specific scenarios with `go test -run TestAsteroidCollision/all_left_moving`. Adopt this convention from the start of a project rather than retrofitting it later.

---
