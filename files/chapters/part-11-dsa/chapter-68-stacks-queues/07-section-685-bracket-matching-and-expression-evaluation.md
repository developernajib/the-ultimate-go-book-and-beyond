## 68.5 Bracket Matching and Expression Evaluation

### Valid Parentheses

The stack-based approach works because every closing bracket must match the most recently opened bracket, which is exactly the LIFO ordering a stack provides. Pushing open brackets and comparing on close means a mismatch or empty stack at any closing bracket immediately signals invalidity, while a non-empty stack at the end means unmatched opens remain.

```go
// IsValid checks if brackets are balanced
// LeetCode 20: Valid Parentheses
// Time: O(n), Space: O(n)
func IsValid(s string) bool {
    stack := []rune{}
    pairs := map[rune]rune{
        ')': '(',
        '}': '{',
        ']': '[',
    }

    for _, ch := range s {
        if ch == '(' || ch == '{' || ch == '[' {
            stack = append(stack, ch)
        } else {
            if len(stack) == 0 || stack[len(stack)-1] != pairs[ch] {
                return false
            }
            stack = stack[:len(stack)-1]
        }
    }

    return len(stack) == 0
}

// MinRemoveToMakeValid removes minimum parentheses to make string valid
// LeetCode 1249: Minimum Remove to Make Valid Parentheses
// Time: O(n), Space: O(n)
func MinRemoveToMakeValid(s string) string {
    bytes := []byte(s)
    stack := []int{} // indices of '('

    // Mark invalid '(' and ')' with '*'
    for i := 0; i < len(bytes); i++ {
        if bytes[i] == '(' {
            stack = append(stack, i)
        } else if bytes[i] == ')' {
            if len(stack) > 0 {
                stack = stack[:len(stack)-1]
            } else {
                bytes[i] = '*' // mark for removal
            }
        }
    }

    // Mark remaining unmatched '('
    for _, idx := range stack {
        bytes[idx] = '*'
    }

    // Build result without '*'
    result := []byte{}
    for _, b := range bytes {
        if b != '*' {
            result = append(result, b)
        }
    }

    return string(result)
}

// LongestValidParentheses finds the longest valid parentheses substring
// LeetCode 32: Longest Valid Parentheses
// Time: O(n), Space: O(n)
func LongestValidParentheses(s string) int {
    stack := []int{-1} // base for calculating length
    maxLen := 0

    for i := 0; i < len(s); i++ {
        if s[i] == '(' {
            stack = append(stack, i)
        } else {
            stack = stack[:len(stack)-1]

            if len(stack) == 0 {
                stack = append(stack, i)
            } else {
                length := i - stack[len(stack)-1]
                if length > maxLen {
                    maxLen = length
                }
            }
        }
    }

    return maxLen
}

// GenerateParenthesis generates all valid combinations
// LeetCode 22: Generate Parentheses
// Time: O(4^n / sqrt(n)), Space: O(n)
func GenerateParenthesis(n int) []string {
    result := []string{}
    generate(&result, "", n, n)
    return result
}

func generate(result *[]string, current string, open, close int) {
    if open == 0 && close == 0 {
        *result = append(*result, current)
        return
    }

    if open > 0 {
        generate(result, current+"(", open-1, close)
    }

    if close > open {
        generate(result, current+")", open, close-1)
    }
}
```

### Expression Evaluation

Reverse Polish Notation eliminates operator precedence ambiguity by placing operators after their operands, so evaluation is a single left-to-right pass: push operands, and on each operator pop the top two values, apply the operation, and push the result. The `Calculate` function handles infix notation with parentheses by using the stack to save and restore the running result and sign whenever a sub-expression is entered or exited.

```go
import "strconv"

// EvalRPN evaluates Reverse Polish Notation expression
// LeetCode 150: Evaluate Reverse Polish Notation
// Time: O(n), Space: O(n)
//
// Note the operand order: the FIRST pop is the right operand. Getting this
// backwards is invisible for + and *, and silently wrong for - and /.
func EvalRPN(tokens []string) int {
    stack := []int{}

    for _, token := range tokens {
        switch token {
        case "+":
            b, a := stack[len(stack)-1], stack[len(stack)-2]
            stack = stack[:len(stack)-2]
            stack = append(stack, a+b)
        case "-":
            b, a := stack[len(stack)-1], stack[len(stack)-2]
            stack = stack[:len(stack)-2]
            stack = append(stack, a-b)
        case "*":
            b, a := stack[len(stack)-1], stack[len(stack)-2]
            stack = stack[:len(stack)-2]
            stack = append(stack, a*b)
        case "/":
            b, a := stack[len(stack)-1], stack[len(stack)-2]
            stack = stack[:len(stack)-2]
            stack = append(stack, a/b)
        default:
            num, _ := strconv.Atoi(token)
            stack = append(stack, num)
        }
    }

    return stack[0]
}

// Calculate evaluates a basic expression with +, -, (, )
// LeetCode 224: Basic Calculator
// Time: O(n), Space: O(n)
func Calculate(s string) int {
    stack := []int{}
    result := 0
    sign := 1
    num := 0

    for i := 0; i < len(s); i++ {
        ch := s[i]

        if ch >= '0' && ch <= '9' {
            num = num*10 + int(ch-'0')
        } else if ch == '+' {
            result += sign * num
            sign = 1
            num = 0
        } else if ch == '-' {
            result += sign * num
            sign = -1
            num = 0
        } else if ch == '(' {
            // Push current result and sign
            stack = append(stack, result)
            stack = append(stack, sign)
            result = 0
            sign = 1
        } else if ch == ')' {
            result += sign * num
            num = 0

            // Pop sign and previous result
            result *= stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result += stack[len(stack)-1]
            stack = stack[:len(stack)-1]
        }
    }

    result += sign * num
    return result
}

// CalculateII evaluates expression with +, -, *, /
// LeetCode 227: Basic Calculator II
// Time: O(n), Space: O(n)
func CalculateII(s string) int {
    stack := []int{}
    num := 0
    op := byte('+')

    for i := 0; i < len(s); i++ {
        ch := s[i]

        if ch >= '0' && ch <= '9' {
            num = num*10 + int(ch-'0')
        }

        if (ch != ' ' && !(ch >= '0' && ch <= '9')) || i == len(s)-1 {
            switch op {
            case '+':
                stack = append(stack, num)
            case '-':
                stack = append(stack, -num)
            case '*':
                stack[len(stack)-1] *= num
            case '/':
                stack[len(stack)-1] /= num
            }
            op = ch
            num = 0
        }
    }

    result := 0
    for _, n := range stack {
        result += n
    }
    return result
}
```

The `|| i == len(s)-1` in `CalculateII` is doing real work and is easy to misread. Operators are applied when the *next* operator is seen, so the final operand would never be flushed without a trigger at the end of input. The condition fires on the last character whatever it is, digit or trailing space, which is why `"3+2"` and `"3+2 "` both evaluate correctly. It also relies on Go's integer division truncating toward zero, so `-3/2` is `-1` and the pushed-negative trick for subtraction gives the same answer as negating the quotient. In a language where division floors toward negative infinity, `"14-3/2"` would come out wrong.

### Junior -> FAANG: Bracket Matching and Expression Evaluation as Interview Staples

Bracket matching (LeetCode 20) is the most common stack warm-up problem in FAANG interviews. Interviewers use it to verify that you know the stack pattern before moving to harder problems. You should be able to write it in under five minutes.

**The two failure modes of bracket matching:**
1. Closing bracket with no matching open: `len(stack) == 0` at the point of checking.
2. Extra open brackets at the end: `len(stack) != 0` after the loop.

Both must be handled. The most common bug is forgetting the second failure mode and returning `true` when the stack still has unmatched opens.

**`MinRemoveToMakeValid` interview insight:** The two-pass approach (mark invalid with `*`, then filter) is cleaner than trying to build the result string in one pass. In interviews, prefer clarity over one-pass optimization unless the interviewer specifically asks for it.

**`LongestValidParentheses` trick:** The stack starts with `-1` as a sentinel base index. When a `)` pops the stack and the stack becomes empty, you push the current index as the new base. This avoids special-casing the "no valid prefix" scenario.

**Expression evaluation (LeetCode 224 and 227):** These are medium problems that require careful state management. The key insight for LeetCode 224 is that when you encounter `(`, you push the current result and sign onto the stack and reset both. When you encounter `)`, you pop and combine. For LeetCode 227, the key insight is that you can handle `*` and `/` by immediately applying them to the top of the stack, deferring `+` and `-` to a final summation.

**First-job habit:** For any expression evaluation problem, identify the operators and their precedence before coding. Write a table: "Which operators are handled immediately vs. deferred?" This prevents the common mistake of trying to handle all operators uniformly when they have different precedence.

### Senior @ FAANG: Expression Evaluation as a Parser Engineering Problem

**Bracket matching as a pushdown automaton.** Valid parentheses checking recognizes the Dyck language, which is context-free and provably not regular, and this is the cleanest available demonstration of why a stack is not a convenience here but a requirement. A finite automaton has no way to remember an unbounded nesting depth, so no regular expression can validate balanced brackets, which is the rigorous version of the advice never to parse nested structures with regex. What the algorithm implements is a deterministic pushdown automaton: finite control plus one stack. Calling it an LR(0) parser overstates it, since there is no grammar, no item sets, and no parse table, though it is fair to say a real LR parser is this same idea generalized. In production this pattern appears in JSON and YAML validators, code formatters tracking indent levels, and protocol parsers tracking nested message boundaries.

**ADR: stack-based vs. recursive descent for expression evaluation.** LeetCode 224 uses a stack-based approach that handles `+`, `-`, and parentheses. Adding `*` and `/` requires handling operator precedence, which LeetCode 227 addresses by eager evaluation of higher-precedence operators. A full expression evaluator (all four operators plus exponentiation and unary negation) is better implemented as a recursive descent parser because the precedence hierarchy maps naturally to recursive function calls, with each precedence level as a function. Stack-based implementations of full precedence handling become difficult to maintain. The ADR question is: "Will the expression language grow?" If yes, start with recursive descent.

**`LongestValidParentheses` as a dynamic programming vs. stack trade-off.** The stack approach runs in O(n) time and O(n) space. There is a DP approach that also runs in O(n) time and O(n) space (storing the length of the longest valid parentheses ending at each index). There is also a two-pass O(n) time and O(1) space approach using two counters (left and right) scanning forward and backward. The three approaches are algorithmically equivalent. In a code review, the preference is for whichever is most readable to the team. A senior engineer reviewing a PR that changes from the stack approach to the two-counter approach should ask for a comment explaining why the change was made and whether the O(1) space was a measured requirement.

**Production use case: calculator as a service.** A calculator service that evaluates user-submitted arithmetic expressions is a production system with security implications. User input must be sanitized to reject arbitrary code execution. A stack-based evaluator with an explicit token type (`number`, `operator`, `paren`) and a whitelist of allowed operators is safer than passing the expression to `eval` or a scripting language interpreter. The `CalculateII` implementation is approximately the right structure for such a service, extended with input validation and a bound on nesting depth. Note that every evaluator in this section trusts its input completely and would need hardening first: `EvalRPN` indexes `stack[len(stack)-2]` without checking the stack holds two operands, so a malformed token stream panics rather than erroring, it discards the error from `strconv.Atoi` so a garbage token silently becomes zero, and none of them guard against division by zero, which panics with a runtime error. For a service, each of those is a request that kills the handler. Validate the token stream first, return errors rather than panicking, and recover at the handler boundary as a backstop rather than as the strategy.
