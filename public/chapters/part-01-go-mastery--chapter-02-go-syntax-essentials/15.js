export default `## Exercises

### How to Verify Your Solutions

For every exercise below, follow this process:

1. **Create a Go file** in a new directory: \`mkdir exercise1 && cd exercise1 && go mod init exercise1\`
2. **Write your solution** in \`main.go\`
3. **Run it**: \`go run main.go\`
4. **Check against expected output** listed below each exercise
5. **Write a test**: Create \`main_test.go\` and run \`go test -v\`, if your tests pass, your solution is correct

If you get stuck for more than 20 minutes, re-read the relevant section, then try again. Don't look up the answer online, the struggle is where learning happens.

---

1. **Temperature Converter**: Write a program that converts Celsius to Fahrenheit and vice versa. Use functions with named return values. Handle invalid input with proper error messages.

   **Expected output:**
   \`\`\`
   100°C = 212.00°F
   32°F = 0.00°C
   -40°C = -40.00°F
   \`\`\`
   **Self-check:** Does \`CtoF(0)\` return \`32\`? Does \`FtoC(212)\` return \`100\`? Does invalid input print an error, not panic?

2. **Word Counter**: Write a function that takes a string and returns a \`map[string]int\` counting the frequency of each word. Test it with \`"the quick brown fox jumps over the lazy dog the quick fox"\`.

   **Expected output (order may vary):**
   \`\`\`
   the: 2, quick: 2, fox: 2, brown: 1, jumps: 1, over: 1, lazy: 1, dog: 1
   \`\`\`
   **Self-check:** Write a test: \`func TestWordCount(t *testing.T)\` that checks \`wordCount("hello hello world")\` returns \`map[string]int{"hello": 2, "world": 1}\`.

3. **Student Grade Calculator**: Define a \`Student\` struct with \`Name\`, \`Scores []float64\`, and methods \`Average() float64\` and \`Grade() string\` (A/B/C/D/F based on average: A>=90, B>=80, C>=70, D>=60, F<60). Create a slice of 5 students and print a report card.

   **Expected output format:**
   \`\`\`
   Name            Average  Grade
   --------------------------------
   Alice           92.50    A
   Bob             78.33    C
   \`\`\`
   **Self-check:** Does a student with scores \`[100, 80, 90]\` get average \`90.0\` and grade \`A\`? Does an empty scores slice return \`0.0\` (not panic)?

4. **Slice Operations**: Implement the following without using any external packages and without the standard library \`slices\` package:
   - \`Reverse([]int) []int\`, reverse a slice
   - \`Contains([]int, int) bool\`, check if element exists
   - \`Unique([]int) []int\`, remove duplicates
   - \`Filter([]int, func(int) bool) []int\`, keep elements matching predicate

   **Self-check test cases:**
   \`\`\`go
   Reverse([]int{1, 2, 3})           // [3, 2, 1]
   Reverse([]int{})                   // []
   Contains([]int{1, 2, 3}, 2)       // true
   Contains([]int{1, 2, 3}, 5)       // false
   Unique([]int{1, 2, 2, 3, 1})      // [1, 2, 3]
   Filter([]int{1, 2, 3, 4, 5}, func(n int) bool { return n > 3 }) // [4, 5]
   \`\`\`

   Then rewrite each using \`slices.Reverse\`, \`slices.Contains\`, \`slices.Compact\` (after sorting, for unique), and \`slices.DeleteFunc\` (for the inverse of filter). Compare line counts and benchmark both versions on a slice of 100,000 random integers. Note when your hand-rolled version beats the stdlib (reusing a buffer) and when the stdlib wins (vectorized paths on newer Go versions).

5. **Simple Calculator**: Build an interactive calculator that reads expressions like \`add 5 3\`, \`multiply 4 7\`, \`divide 10 0\` from stdin. Handle division by zero with proper errors. Use a \`switch\` statement for operation dispatch.

   **Expected behavior:**
   \`\`\`
   > add 5 3
   Result: 8
   > divide 10 0
   Error: division by zero
   > multiply 4 7
   Result: 28
   > unknown 1 2
   Error: unknown operation "unknown"
   \`\`\`

6. **Contact Book Extension**: Extend the contact book from Section 1B.8 to support:
   - Deleting contacts by name
   - Updating a contact's email or phone
   - Listing contacts sorted alphabetically (use \`slices.SortFunc\` from the standard library, or \`sort.Slice\` if you want practice with the older API)

   **Self-check:** Add 3 contacts, delete 1, verify \`list\` shows 2 contacts in alphabetical order. Update an email, verify \`search\` returns the new email.

---

### Junior to FAANG-Entry Track

These exercises target the muscle memory and fluency that an entry-level Go interview probes. Time yourself. The interview bar at Google, Meta, Amazon, and Stripe assumes you can produce a clean, working solution to each in under 20 minutes from a blank file with no reference.

7. **FizzBuzz from a blank file.** Print numbers 1 to 100, replacing multiples of 3 with \`Fizz\`, multiples of 5 with \`Buzz\`, and multiples of both with \`FizzBuzz\`. Constraint: write it three times, with no reference between attempts, and time the third one. The third attempt should be under three minutes. The point is fluency, not novelty.

8. **Read a CSV from stdin and print the second column.** No imports beyond \`encoding/csv\`, \`os\`, and \`fmt\`. Handle the error from \`csv.NewReader.ReadAll\`. Self-check: pipe \`printf 'a,b,c\\nd,e,f\\n' | go run main.go\` and verify the output is \`b\\ne\\n\`.

9. **Anagram check.** Write \`func IsAnagram(a, b string) bool\` that returns true if \`a\` and \`b\` contain the same letters in any order, ignoring case and spaces. Constraint: do it twice, once with sort and once with a \`map[rune]int\` frequency count. Compare the two solutions on inputs of length one million and explain which is faster and why. This is a frequent phone-screen question across the industry.

10. **In-memory LRU cache (no concurrency).** Implement \`type LRU struct\` with \`Get(key string) (string, bool)\` and \`Put(key, value string)\` that evicts the least-recently-used entry when capacity is exceeded. Use a \`map[string]*list.Element\` plus \`container/list\`. Self-check: with capacity 2, after \`Put("a","1"); Put("b","2"); Get("a"); Put("c","3")\`, the key \`b\` is evicted, not \`a\`. This is the canonical "implement LRU" interview question and the Go standard library gives you the building blocks for free.

### Senior at FAANG Track

These exercises do not test syntax. They test the kind of judgment that distinguishes a senior engineer from a fluent one.

11. **API design exercise.** Take the contact book from Section 1B.8 and design (do not implement) the package's public API as it would appear in a \`pkg.go.dev\` documentation page for a real published library. Decide which types and methods are exported, which are internal, what error sentinels you expose, and what the doc comments say. Constraint: every exported identifier needs a doc comment, every error case needs a contract, and the API needs to remain stable across at least one major version. Then write a 500-word design note arguing for your choices and identifying the two or three decisions you would expect to defend in a design review. The exercise is not the code, it is the document.

12. **Error wrapping discipline.** Take a 500-line Go service from your team's repository (or the contact book extended to use a real database). Write a one-page document defining when the team uses \`%w\`, when it uses \`%v\`, when it defines a sentinel error, and when it defines a typed error. Then audit the service against your document and list the violations. The audit is the deliverable. The interesting part is which violations you choose to fix and which you choose to live with, and why.

13. **Onboarding doc.** Write the \`docs/go-onboarding.md\` for an engineer joining your team from a Python background. Constraint: under 1500 words, no code blocks longer than 15 lines, no links to external blog posts, and the reader should be able to write a small Go service in their first week without further guidance from you. The structural lesson here is the order in which Go concepts should be introduced. Use Section 2 of this chapter as a reference but make the doc your own. Then send it to a Python-background engineer on another team and ask for feedback. The feedback is the grade.

14. **Receiver-type audit.** Pick three Go packages you have written or maintained. For each, list every type and the receiver type used by each of its methods. Identify any type with mixed receivers (some on \`T\`, some on \`*T\`). For each mixed type, decide whether to convert to all-pointer or all-value, and write the migration in a single PR. Then write a 200-word retro on what you found and what you changed in your team's review checklist. This is the kind of refactor that pays back over years and never gets prioritised because it is not a feature.

15. **Slice aliasing audit.** Find every public function in a Go package you maintain that returns a slice. For each, decide whether the returned slice is intended to be independent of the function's internal state or not. Document the choice in the function's doc comment. Then audit the call sites and identify any case where the caller mutates the returned slice in a way that violates the function's contract. The audit deliverable is the doc comments and the list of fixes. The lesson is that slice aliasing in Go is a contract that must be documented because the language does not enforce it.
`;
