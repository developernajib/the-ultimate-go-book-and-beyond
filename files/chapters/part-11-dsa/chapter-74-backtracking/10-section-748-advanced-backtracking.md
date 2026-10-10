## 74.8 Advanced Backtracking

### Restore IP Addresses

Restoring IP addresses is a constrained partitioning problem: the string must be split into exactly four segments, each a valid decimal value between 0 and 255 with no leading zeros. Backtracking prunes invalid segments immediately (too long, leading zero, value > 255) and stops recursing when four segments are found or when the remaining string cannot form the required number of segments.

```go
import "strings"

// RestoreIpAddresses returns all valid IP addresses
// LeetCode 93: Restore IP Addresses
// Time: O(1) in the strict sense (at most 3^4 splits), Space: O(1)
func RestoreIpAddresses(s string) []string {
    result := []string{}

    var backtrack func(start, parts int, current []string)
    backtrack = func(start, parts int, current []string) {
        if parts == 4 && start == len(s) {
            result = append(result, strings.Join(current, "."))
            return
        }

        if parts == 4 || start == len(s) {
            return
        }

        for length := 1; length <= 3 && start+length <= len(s); length++ {
            segment := s[start : start+length]

            // Skip invalid segments. The string compare is sound only
            // because length == 3 guarantees both sides are 3 digits, where
            // lexicographic order matches numeric order.
            if (length > 1 && segment[0] == '0') || // leading zero
                (length == 3 && segment > "255") { // > 255
                continue
            }

            current = append(current, segment)
            backtrack(start+length, parts+1, current)
            current = current[:len(current)-1]
        }
    }

    backtrack(0, 0, []string{})
    return result
}
```

### Expression Add Operators

Inserting `+`, `-`, and `*` between digits of a numeric string is hard because multiplication breaks the left-to-right evaluation the running total assumes. By the time you see `*3`, you have already committed the previous operand into `value`, and multiplication needs it back.

The fix is to track `prevOperand`, the last operand as it was applied, signed. When `*` is chosen, correct the running value with `value - prevOperand + prevOperand * operand`: subtract what the previous operand contributed, then add what it contributes as a product. This re-establishes precedence without parsing anything. The sign matters, which is why the `-` branch passes `-operand` rather than `operand`: after `1-2`, `prevOperand` is `-2`, so `1-2*3` correctly gives `1 - 2*3 = -5` rather than `1 - 2 + 2*3 = 5`.

Two constraints ride along. Operands may be multi-digit, so each level tries every operand length starting at `start`. And leading zeros are illegal, so an operand starting with `0` is never extended: `"0"` is a valid token, `"05"` is not.

```go
// AddOperators adds operators to reach target
// LeetCode 282: Expression Add Operators
// Time: O(4^n) (at each gap: extend the operand, or +, -, *), Space: O(n)
func AddOperators(num string, target int) []string {
    result := []string{}
    if len(num) == 0 {
        return result
    }

    // prevOperand is the last operand as it was APPLIED to value, signed:
    // after "1-2" it is -2, so a following "*3" can undo it correctly.
    var backtrack func(start int, prevOperand, value int64, expr []byte)
    backtrack = func(start int, prevOperand, value int64, expr []byte) {
        if start == len(num) {
            if value == int64(target) {
                result = append(result, string(expr))
            }
            return
        }

        var operand int64
        for end := start; end < len(num); end++ {
            // "0" is a legal operand, "05" is not: once the token starts
            // with '0' it can never be extended.
            if end > start && num[start] == '0' {
                break
            }

            operand = operand*10 + int64(num[end]-'0')
            token := num[start : end+1] // the FULL operand, not one digit
            mark := len(expr)           // restore point for the unchoose step

            // The first operand takes no operator in front of it.
            if start == 0 {
                expr = append(expr, token...)
                backtrack(end+1, operand, operand, expr)
                expr = expr[:mark]
                continue
            }

            expr = append(expr, '+')
            expr = append(expr, token...)
            backtrack(end+1, operand, value+operand, expr)
            expr = expr[:mark]

            expr = append(expr, '-')
            expr = append(expr, token...)
            backtrack(end+1, -operand, value-operand, expr)
            expr = expr[:mark]

            // Undo prevOperand's contribution, then re-apply it as a product.
            expr = append(expr, '*')
            expr = append(expr, token...)
            backtrack(end+1, prevOperand*operand,
                value-prevOperand+prevOperand*operand, expr)
            expr = expr[:mark]
        }
    }

    backtrack(0, 0, 0, []byte{})
    return result
}
```

The operand loop is the load-bearing part, and it is where a plausible-looking version of this function goes wrong. It is tempting to consume one digit per recursion level and carry a `currentOperand` accumulator, appending only `num[index]` to the expression when an operator is committed. That structure computes the right *value* and prints the wrong *expression*: the digits consumed while extending a multi-digit operand never reach `expr`, so `"12"` with target 12 yields `"2"`, and `"105"` with target 5 yields `"0-5"` while missing the correct `"10-5"`. The output looks like a list of expressions and is quietly missing digits.

Building `token := num[start:end+1]` from the outer loop keeps value and expression in lockstep by construction. When you write this, check it the way you would check any enumeration: parse each returned string with an independent evaluator, confirm it equals the target, and confirm its digits, concatenated, reproduce the input exactly. That last check is the one that catches this bug.

### Junior → FAANG: Advanced Backtracking and the Operator Precedence Trick

Restore IP Addresses (LeetCode 93) is an advanced backtracking problem because it combines several constraints. The implementation above enforces two of them inside the loop, both mapping to a rule in the IP format: reject a multi-digit segment starting with `'0'`, and reject a 3-digit segment above 255.

The `segment > "255"` test deserves a second look, because it compares *strings* and yet it is correct. Go compares strings lexicographically, and for two strings of the same length over the digit characters, lexicographic order and numeric order coincide: `"256" > "255"`, `"300" > "255"`, `"199" < "255"`. The guard is only reached when `length == 3`, so both sides are always 3 digits and the comparison is sound. Change the guard to run at other lengths and it breaks instantly, since `"9" > "255"` lexicographically while 9 < 255. It works because of a precondition, not because string comparison is a substitute for parsing.

A third pruning is available and is *not* in the code above: bounding on remaining length. With `segments` placed and `remaining` characters left, the branch is hopeless when `remaining < (4 - segments)` (not enough characters to fill the rest) or `remaining > (4 - segments) * 3` (too many to fit). Adding it is a good exercise, and it kills whole subtrees before any character-level validation runs.

Expression Add Operators (LeetCode 282) is one of the hardest backtracking problems because of the multiplication precedence issue. The insight is `prevOperand` tracking: when you multiply, undo the last operand's contribution and replace it with the product. `value - prevOperand + prevOperand * operand` adjusts for the fact that `prevOperand` was already folded into `value` and now needs to be multiplied instead.

Trace `"123"` with target 6 to verify the arithmetic. Along the `1+2*3` path: after `1+2`, `value = 3` and `prevOperand = 2`. Then `*3` gives `3 - 2 + 2*3 = 7`, which is right, because `1+2*3` really is 7 and not 9. Then trace `"232"` with target 8 to see both answers, `2*3+2` and `2+3*2`, come out of the same recurrence. If those two agree with your hand arithmetic, the trick is yours.

Both problems benefit enormously from naming intermediate variables well. In an interview, naming `remaining` instead of `r`, `currentOperand` instead of `cur`, and `prevOperand` instead of `prev` signals professional code quality. Interviewers note naming quality even in algorithm problems.

### Senior @ FAANG: Advanced Backtracking in Protocol Parsing and Expression Evaluation

Restore IP Addresses is a specialized instance of the more general problem of parsing a string that conforms to a known format grammar (four octets separated by dots, each 0-255 with no leading zeros). Production protocol parsers (for HTTP headers, JSON, network packets) face the same structure: the input is a character stream, the output is a tree or list of structured fields, and invalid partial parses should be rejected as early as possible.

Production protocol parsers do not use recursive backtracking directly. They use state machines or parser combinators. But the correctness of the parser is often verified by comparing its output against a reference implementation that is a direct translation of the backtracking algorithm. The backtracking version serves as the "oracle" in differential testing: run both parsers on a large set of random inputs and compare outputs. Any discrepancy indicates a bug in the production parser.

Expression Add Operators generalizes to arbitrary expression evaluation with operator precedence, which is the problem solved by Pratt parsers in production compilers. The `prevOperand` trick is a special case of maintaining the incomplete expression context (the operand that has been read but not yet combined with its left neighbor due to precedence rules). Staff engineers who have traced through the Add Operators implementation have built the intuition needed to understand Pratt parsing, which is the production technique for implementing operator-precedence parsers in Go and other languages without a parser generator.

### Junior → FAANG: Advanced Backtracking as a Signal of Depth

The two problems in this file (Restore IP Addresses and Expression Add Operators) are advanced because they require non-standard pruning logic (multi-constraint segment validation for IP, operator precedence tracking for add operators). In an interview, reaching for these problems signals that you have practiced beyond the standard backtracking curriculum.

For Restore IP Addresses, the most important pruning is the remaining-length bound: `remaining < (4 - segments)` (too short to form the required number of segments) or `remaining > (4 - segments) * 3` (too long, cannot fit into the required number of segments). This pruning eliminates most branches before any character-level validation happens, making it the highest-value optimization in the function. Implement this pruning first, then validate individual segments.

For Expression Add Operators, trace "1+2*3" by hand to verify the `prevOperand` arithmetic. When you reach `*3`, the current value is `1 + 2 = 3` and `prevOperand = 2`. After multiplication the value becomes `3 - 2 + 2*3 = 7`, which is `value - prevOperand + prevOperand * operand`. Then trace `1-2*3`, where the sign carries: `prevOperand` is `-2`, so the value becomes `-1 - (-2) + (-2 * 3) = -5`. Correct, since `1-2*3` is `-5`. If both of those land, you understand the algorithm.

### Senior @ FAANG: Protocol Parsing and Expression Evaluation in Production

Restore IP Addresses is a specific instance of the general grammar-directed parsing problem. Production protocol parsers (for HTTP headers, SMTP, DNS) implement essentially the same algorithm using state machines compiled from the grammar rather than recursive backtracking. The key engineering decision is when to use backtracking (small grammar, low performance requirements, ease of development) versus state machine (large grammar, high performance requirements, security-sensitive parsing).

For security-sensitive protocol parsers, backtracking is explicitly avoided because it makes worst-case performance hard to bound and can be exploited by adversarial inputs. State machines with linear time guarantees are required. Go's `net/http` parser uses a handwritten state machine for HTTP header parsing precisely for this reason: it guarantees O(n) parsing time for any input, regardless of how the headers are structured.

The Expression Add Operators Pratt parser connection is particularly relevant for engineers who implement DSLs (domain-specific languages) for configuration, query languages, or formula evaluation. A Pratt parser is typically 100-200 lines of clean Go code, handles arbitrary operator precedence and associativity, and is the recommended approach for any expression language with more than 3-4 operator types. The `prevOperand` trick in the backtracking solution is the intuition that makes the Pratt parsing "right denotation" function understandable.
