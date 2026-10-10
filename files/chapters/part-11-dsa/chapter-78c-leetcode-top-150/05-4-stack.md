## 78C.4 Stack

Stacks solve problems where you need to match or track elements in a Last-In-First-Out order: parentheses, monotonic sequences, and expression evaluation.

---
### LC 20 - Valid Parentheses 🟢

**Key Insight**: Push opening brackets. On closing brackets, pop and verify the match.

```go
func isValid(s string) bool {
    stack := []byte{}
    match := map[byte]byte{')': '(', ']': '[', '}': '{'}

    for i := 0; i < len(s); i++ {
        if s[i] == '(' || s[i] == '[' || s[i] == '{' {
            stack = append(stack, s[i])
        } else {
            if len(stack) == 0 || stack[len(stack)-1] != match[s[i]] {
                return false
            }
            stack = stack[:len(stack)-1]
        }
    }
    return len(stack) == 0
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 155 - Min Stack 🟡

**Key Insight**: Maintain a parallel stack tracking the minimum at each level. Every push and pop keeps it in sync.

```go
type MinStack struct {
    stack    []int
    minStack []int
}

func Constructor() MinStack {
    return MinStack{}
}

func (s *MinStack) Push(val int) {
    s.stack = append(s.stack, val)
    if len(s.minStack) == 0 || val <= s.minStack[len(s.minStack)-1] {
        s.minStack = append(s.minStack, val)
    } else {
        s.minStack = append(s.minStack, s.minStack[len(s.minStack)-1])
    }
}

func (s *MinStack) Pop() {
    s.stack = s.stack[:len(s.stack)-1]
    s.minStack = s.minStack[:len(s.minStack)-1]
}

func (s *MinStack) Top() int {
    return s.stack[len(s.stack)-1]
}

func (s *MinStack) GetMin() int {
    return s.minStack[len(s.minStack)-1]
}
```
**Time**: O(1) for all operations.
**Space**: O(n).

---
### LC 150 - Evaluate Reverse Polish Notation 🟡

**Key Insight**: Push numbers. On operators, pop two operands, compute, push result.

```go
func evalRPN(tokens []string) int {
    stack := []int{}

    for _, token := range tokens {
        switch token {
        case "+", "-", "*", "/":
            b := stack[len(stack)-1]
            a := stack[len(stack)-2]
            stack = stack[:len(stack)-2]
            var result int
            switch token {
            case "+":
                result = a + b
            case "-":
                result = a - b
            case "*":
                result = a * b
            case "/":
                result = a / b
            }
            stack = append(stack, result)
        default:
            num, _ := strconv.Atoi(token)
            stack = append(stack, num)
        }
    }
    return stack[0]
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 71 - Simplify Path 🟡

**Key Insight**: Split by `/` and use a stack. Push directory names, pop on `..`, ignore `.` and empty strings.

```go
func simplifyPath(path string) string {
    parts := strings.Split(path, "/")
    stack := []string{}

    for _, part := range parts {
        switch part {
        case "", ".":
            continue
        case "..":
            if len(stack) > 0 {
                stack = stack[:len(stack)-1]
            }
        default:
            stack = append(stack, part)
        }
    }
    return "/" + strings.Join(stack, "/")
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 84 - Largest Rectangle in Histogram 🔴

**Key Insight**: Use a monotonic increasing stack of indices. When a shorter bar is found, pop and calculate area with the popped bar as the shortest.

```go
func largestRectangleArea(heights []int) int {
    stack := []int{} // indices
    maxArea := 0
    n := len(heights)

    for i := 0; i <= n; i++ {
        h := 0
        if i < n {
            h = heights[i]
        }
        for len(stack) > 0 && heights[stack[len(stack)-1]] > h {
            height := heights[stack[len(stack)-1]]
            stack = stack[:len(stack)-1]
            width := i
            if len(stack) > 0 {
                width = i - stack[len(stack)-1] - 1
            }
            area := height * width
            if area > maxArea {
                maxArea = area
            }
        }
        stack = append(stack, i)
    }
    return maxArea
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 394 - Decode String 🟡

**Key Insight**: Use two stacks, one for counts and one for strings. On `]`, pop and repeat the current string.

```go
func decodeString(s string) string {
    countStack := []int{}
    strStack := []string{}
    current := ""
    k := 0

    for i := 0; i < len(s); i++ {
        c := s[i]
        switch {
        case c >= '0' && c <= '9':
            k = k*10 + int(c-'0')
        case c == '[':
            countStack = append(countStack, k)
            strStack = append(strStack, current)
            current = ""
            k = 0
        case c == ']':
            count := countStack[len(countStack)-1]
            countStack = countStack[:len(countStack)-1]
            prev := strStack[len(strStack)-1]
            strStack = strStack[:len(strStack)-1]
            current = prev + strings.Repeat(current, count)
        default:
            current += string(c)
        }
    }
    return current
}
```
**Time**: O(output length).
**Space**: O(output length).

---
### LC 739 - Daily Temperatures 🟡

**Key Insight**: Monotonic decreasing stack. When a warmer day is found, pop all cooler days and record the distance.

```go
func dailyTemperatures(temperatures []int) []int {
    n := len(temperatures)
    result := make([]int, n)
    stack := []int{} // indices

    for i := 0; i < n; i++ {
        for len(stack) > 0 && temperatures[i] > temperatures[stack[len(stack)-1]] {
            j := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[j] = i - j
        }
        stack = append(stack, i)
    }
    return result
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 853 - Car Fleet 🟡

**Key Insight**: Sort cars by position descending, then compute arrival times. A car that arrives later than every car ahead of it forms a new fleet, so a running maximum of arrival times is enough and no explicit stack is needed.

```go
func carFleet(target int, position []int, speed []int) int {
    n := len(position)
    type car struct {
        pos  int
        time float64
    }

    cars := make([]car, n)
    for i := 0; i < n; i++ {
        cars[i] = car{position[i], float64(target-position[i]) / float64(speed[i])}
    }
    sort.Slice(cars, func(i, j int) bool {
        return cars[i].pos > cars[j].pos
    })

    fleets := 0
    maxTime := 0.0
    for _, c := range cars {
        if c.time > maxTime {
            fleets++
            maxTime = c.time
        }
    }
    return fleets
}
```
**Time**: O(n log n), dominated by the sort.
**Space**: O(n).

---
### LC 224 - Basic Calculator 🔴

**Key Insight**: With only `+`, `-`, and parentheses there is no precedence to resolve, so no operator stack is needed. Carry a running `result` and a running `sign`, and push only the pair `(result, sign)` that a `(` interrupts. Every term is folded into `result` the moment its sign is known.

```go
func calculate(s string) int {
    result, num, sign := 0, 0, 1
    var stack []int // alternating outer result and outer sign

    for i := 0; i < len(s); i++ {
        c := s[i]
        switch {
        case c >= '0' && c <= '9':
            num = num*10 + int(c-'0') // digits may be multi-character
        case c == '+':
            result += sign * num
            num, sign = 0, 1
        case c == '-':
            result += sign * num
            num, sign = 0, -1
        case c == '(':
            stack = append(stack, result, sign) // suspend the outer expression
            result, sign = 0, 1                 // start the inner one fresh
        case c == ')':
            result += sign * num
            num = 0
            outerSign := stack[len(stack)-1]
            outerResult := stack[len(stack)-2]
            stack = stack[:len(stack)-2]
            result = outerResult + outerSign*result
        }
        // spaces fall through every case and are ignored
    }
    return result + sign*num // flush the final term
}
```

Two details decide whether this passes. First, the trailing `result + sign*num` is mandatory, because the last number has no operator after it to trigger the fold. Second, a leading `-` such as in `-2+1` or `-(3+4)` needs no special handling: `result` starts at 0, so the unary minus is treated as a binary subtraction from zero and comes out correct for free.

**Time**: O(n) - one pass, each character handled once.
**Space**: O(n) - the stack depth matches the nesting depth.

---

### Junior → FAANG: Stack Problems and the Matching Invariant

All stack problems in this section share one invariant: elements are pushed onto the stack when they are "unresolved" and popped when they are "resolved" by a later element. For Valid Parentheses, an opening bracket is unresolved until its matching closing bracket appears. For Daily Temperatures, a day is unresolved until a warmer day is found. Identifying the "unresolved condition" and the "resolution event" for any new problem immediately tells you what to push and when to pop.

The asteroid collision problem is a good test of stack clarity: push rightward asteroids unconditionally, but when a leftward asteroid arrives, pop rightward asteroids until one is larger or the stack is empty. The key loop condition is `len(stack) > 0 && stack[top] > 0 && stack[top] < abs(asteroid)`. Getting this condition exactly right in one take (rather than iterating through wrong conditions) is the interview signal.

The Largest Rectangle in Histogram solution above uses a sentinel: the loop runs to `i == n` with a virtual height of zero, so every unresolved bar is flushed on the final iteration. That removes the need for a separate post-loop cleanup pass, and using a virtual sentinel rather than appending to `heights` leaves the caller's slice untouched.

### Senior @ FAANG: Stack-Based Expression Evaluation in Build Systems

Stack-based expression evaluation is used in build system dependency resolution, reverse polish notation calculators embedded in configuration files, and postfix expression interpreters in bytecode VMs. Go's `text/template` package uses a stack-based evaluation model internally. When debugging unexpected template evaluation behavior, understanding that the engine processes expressions in a stack-based manner helps you predict the evaluation order without reading the full evaluator source code.

For production code review, seeing deeply nested stack operations is a signal to ask whether the stack depth is bounded. An unbounded stack in a production service processing user-supplied input is a denial-of-service vector: a deeply nested input exhausts memory. Always ask "what is the maximum stack depth?" and verify there is either a hard bound or an explicit rejection of inputs that would exceed it.
