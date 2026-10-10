## 73.5 String DP

### Palindrome Problems

The DP palindrome check fills a 2D boolean table where `dp[i][j]` is true when the substring `s[i..j]` is a palindrome. Every substring of length 1 is trivially a palindrome, and longer substrings are palindromes only when the outer characters match and the inner substring is also a palindrome. Iterating by increasing substring length ensures that shorter substrings are already computed when needed.

```go
// LongestPalindrome finds longest palindromic substring
// LeetCode 5: Longest Palindromic Substring
// Time: O(n^2), Space: O(n^2). Expand-around-center solves it in O(1) space.
func LongestPalindrome(s string) string {
    n := len(s)
    if n < 2 {
        return s
    }

    // dp[i][j] = true if s[i:j+1] is palindrome
    dp := make([][]bool, n)
    for i := range dp {
        dp[i] = make([]bool, n)
        dp[i][i] = true // single chars are palindromes
    }

    start, maxLen := 0, 1

    // Check substrings of length 2
    for i := 0; i < n-1; i++ {
        if s[i] == s[i+1] {
            dp[i][i+1] = true
            start = i
            maxLen = 2
        }
    }

    // Check substrings of length 3 and more
    for length := 3; length <= n; length++ {
        for i := 0; i <= n-length; i++ {
            j := i + length - 1
            if s[i] == s[j] && dp[i+1][j-1] {
                dp[i][j] = true
                if length > maxLen {
                    start = i
                    maxLen = length
                }
            }
        }
    }

    return s[start : start+maxLen]
}

// CountSubstrings counts palindromic substrings
// LeetCode 647: Palindromic Substrings
// Time: O(n^2), Space: O(1)
func CountSubstrings(s string) int {
    count := 0
    n := len(s)

    // Expand around center
    expandCount := func(left, right int) int {
        c := 0
        for left >= 0 && right < n && s[left] == s[right] {
            c++
            left--
            right++
        }
        return c
    }

    for i := 0; i < n; i++ {
        count += expandCount(i, i)   // odd length
        count += expandCount(i, i+1) // even length
    }

    return count
}

// MinCut finds minimum cuts for palindrome partitioning
// LeetCode 132: Palindrome Partitioning II
func MinCut(s string) int {
    n := len(s)
    if n <= 1 {
        return 0
    }

    // isPalin[i][j] = true if s[i:j+1] is palindrome
    isPalin := make([][]bool, n)
    for i := range isPalin {
        isPalin[i] = make([]bool, n)
    }

    // Build palindrome table
    for i := n - 1; i >= 0; i-- {
        for j := i; j < n; j++ {
            if s[i] == s[j] && (j-i < 2 || isPalin[i+1][j-1]) {
                isPalin[i][j] = true
            }
        }
    }

    // dp[i] = min cuts for s[0:i+1]
    dp := make([]int, n)
    for i := range dp {
        dp[i] = i // max cuts
    }

    for i := 0; i < n; i++ {
        if isPalin[0][i] {
            dp[i] = 0
        } else {
            for j := 0; j < i; j++ {
                if isPalin[j+1][i] {
                    dp[i] = min(dp[i], dp[j]+1)
                }
            }
        }
    }

    return dp[n-1]
}
```

### Regular Expression Matching

Regex matching with `.` and `*` is harder than wildcard matching because `*` in regex means "zero or more of the preceding element," making its behavior depend on the character before it. The DP table `dp[i][j]` tracks whether the first `i` characters of `s` match the first `j` characters of `p`. The trickiest case is `p[j-1] == '*'`: it either eliminates the preceding character (zero occurrences, referencing `dp[i][j-2]`) or extends a prior match by one character (referencing `dp[i-1][j]`). Wildcard matching with `?` and `*` is simpler because `*` independently matches any sequence, so `dp[i][j]` reduces cleanly to either consuming a character of `s` or consuming nothing from `s`.

```go
// IsMatch checks if string matches pattern with . and *
// LeetCode 10: Regular Expression Matching
// Time: O(m*n), Space: O(m*n)
//
// Precondition: p is a well-formed pattern, meaning every '*' has a preceding
// element to quantify. The j-2 lookbacks below index out of range on a pattern
// like "*" or "a**". LeetCode guarantees this - a real API must validate it.
func IsMatch(s string, p string) bool {
    m, n := len(s), len(p)

    // dp[i][j] = true if s[0:i] matches p[0:j]
    dp := make([][]bool, m+1)
    for i := range dp {
        dp[i] = make([]bool, n+1)
    }

    dp[0][0] = true

    // Handle patterns like a*, a*b*, etc. matching empty string
    for j := 1; j <= n; j++ {
        if p[j-1] == '*' {
            dp[0][j] = dp[0][j-2]
        }
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if p[j-1] == s[i-1] || p[j-1] == '.' {
                dp[i][j] = dp[i-1][j-1]
            } else if p[j-1] == '*' {
                // * matches zero occurrences
                dp[i][j] = dp[i][j-2]
                // * matches one or more
                if p[j-2] == s[i-1] || p[j-2] == '.' {
                    dp[i][j] = dp[i][j] || dp[i-1][j]
                }
            }
        }
    }

    return dp[m][n]
}

// IsMatchWildcard handles ? and *
// LeetCode 44: Wildcard Matching
func IsMatchWildcard(s string, p string) bool {
    m, n := len(s), len(p)
    dp := make([][]bool, m+1)
    for i := range dp {
        dp[i] = make([]bool, n+1)
    }

    dp[0][0] = true
    for j := 1; j <= n && p[j-1] == '*'; j++ {
        dp[0][j] = true
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if p[j-1] == s[i-1] || p[j-1] == '?' {
                dp[i][j] = dp[i-1][j-1]
            } else if p[j-1] == '*' {
                dp[i][j] = dp[i-1][j] || dp[i][j-1]
            }
        }
    }

    return dp[m][n]
}
```

### Junior → FAANG: String DP Pattern Recognition

String DP problems are distinguished by the fact that the state involves two string positions or a string position and a length. The palindrome check (`dp[i][j]` is true when `s[i..j]` is a palindrome) is the canonical 2D boolean DP. The iteration order is critical: you must fill shorter substrings before longer ones, which means iterating by length rather than by starting index.

Regex and wildcard matching are the most conceptually difficult string DP problems because the `*` operator introduces a look-back dependency. For wildcard matching (`?` and `*`), the recurrence is cleaner because `*` independently matches any sequence. For regex matching (`.*`), the `*` depends on the preceding character, and handling "zero occurrences" (referencing `dp[i][j-2]`) versus "one or more occurrences" (referencing `dp[i-1][j]`) requires careful case analysis.

A first-job habit that pays off in interviews: before writing the regex DP, enumerate the three cases in words on the whiteboard. "If `p[j-1]` is a literal character or `.` and matches `s[i-1]`, extend the diagonal. If `p[j-1]` is `*`, either use zero occurrences (reference `dp[i][j-2]`) or, if the preceding pattern character matches `s[i-1]`, use one more occurrence (reference `dp[i-1][j]`)." Interviewers give credit for a correct verbal case analysis even before the code is complete.

### Senior @ FAANG: String DP in Language Processing and Search Infrastructure

Palindromic structure matters in DNA analysis, where many restriction enzymes recognize and cut at reverse-complement palindromic sites. The minimum cut problem (LeetCode 132) generalizes directly into text formatting engines that break text into lines while minimizing a cost function, which is the same partition-a-sequence-at-minimum-cost recurrence with "is a palindrome" swapped for "fits on a line."

The table-filling structure of `IsMatch` is closely related to how linear-time regex engines work, and it is worth being precise about the relationship rather than collapsing it. Both avoid backtracking by tracking, at each input position, the full set of pattern positions still viable, rather than committing to one and unwinding on failure. Engines in the RE2 family (including Go's `regexp`) do this as an explicit NFA simulation over pattern states, which is why they guarantee time linear in the input times the pattern size and never blow up. The price is expressiveness: backreferences and lookaround make the pattern strictly more powerful than a finite automaton, so RE2 and Go's `regexp` simply do not support them. PCRE-style engines do support them, and pay by backtracking.

That trade-off is a platform security concern with a name: ReDoS. A crafted input against a backtracking engine and a poorly structured pattern (nested quantifiers such as `(a+)+$` are the classic shape) can drive exponential work and take down a service. The platform-level mitigations: use an RE2-family engine for any pattern or input that is not fully trusted, and note that if you are writing Go you get this by default, which is a real reason `regexp` refuses the features it refuses. Where a backtracking engine is unavoidable, apply a safety analysis to patterns before compiling them, impose a match timeout or step budget, and rate-limit evaluation per request. Being able to derive why the backtracking approach is vulnerable, from the same reasoning that makes the DP table above run in O(m*n) rather than exponentially, is the signal here.

### Junior → FAANG: String DP as an Interview Category

The three string DP patterns (palindrome, LCS/edit distance, regex matching) are best practiced in that order, because each adds complexity. Palindrome DP uses a 2D boolean table with a length-based fill order. LCS and edit distance use a 2D integer table with row-by-row fill. Regex matching uses a 2D boolean table with a more complex case analysis.

For each pattern, master the table visualization before the code. For palindrome partitioning, be able to draw the `isPalin` table for a 5-character string and identify the iteration order (bottom-right to top-left) in 2 minutes. For edit distance, be able to draw the table for two 3-character strings and label which table direction corresponds to insert, delete, and replace. These visuals are what interviewers want to see drawn on the whiteboard before you write code.

A common first-job mistake in string DP: accessing `s[i-1]` when `i` is 1-indexed for DP but 0-indexed for the string. This off-by-one causes panics or wrong character comparisons. The safe habit is to always access the string with `s[i-1]` in a loop where `i` runs from 1 to `len(s)`, never `s[i]` with `i` running from 0, when the DP table is 1-indexed. Mixing indexing schemes is the source of most string DP bugs.

### Senior @ FAANG: String DP in Search Infrastructure and Content Moderation

The minimum cut variant is the engine behind text layout: breaking a paragraph into lines at minimum total badness is palindrome partitioning with a different predicate and a different cost, and Knuth and Plass built TeX's line breaker on exactly this DP rather than the greedy line-filling that most word processors use.

Edit distance in search infrastructure underlies query rewriting, where a misspelled query is rewritten to the most likely intended query before execution. The constraint is that this must fit inside a per-request latency budget measured in milliseconds, against a dictionary far too large to score exhaustively. The standard architecture is a cascade: cheap n-gram or prefix filtering to knock the candidate set down by orders of magnitude, a structure such as a BK-tree or a Levenshtein automaton to narrow it to a shortlist, and full edit distance DP only on what survives. The design work is in balancing the precision loss at each stage against the latency saved, and in instrumenting each stage so that a shift in the input distribution (new slang, domain-specific misspellings) shows up as measured cascade degradation rather than as user complaints.

Regex engine choice is a platform security decision that belongs in a central security architecture document rather than in individual service READMEs, because the failure mode is a service outage triggered by user input. The justification writes itself once the DP above is internalized: an RE2-family engine bounds work at O(n * |pattern|) regardless of input, a backtracking engine can be driven exponential by a crafted input, and therefore user-controlled patterns must use the former. The cost, no backreferences or lookaround, is the honest other half of that sentence and should be stated in the policy rather than discovered by the first team that needs them.
