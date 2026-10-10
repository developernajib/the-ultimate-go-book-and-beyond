## 83C.17 Mock Interview Session 9: Google L5 Coding - Minimum Window Substring & Serialize/Deserialize Binary Tree

### Interviewer Briefing

**Company style:** Google. L5 (Staff Software Engineer). Two hard LeetCode problems in 45 minutes. Google L5 coding interviews expect near-optimal solutions with clean code, thorough edge case handling, and clear communication. The interviewer will push for follow-ups that test deep understanding.

**Level:** L5 (Staff Software Engineer)

**Interview duration:** 45 minutes (two problems)

**Key evaluation criteria:** Algorithm design, code correctness, edge cases, time management, communication, follow-up depth.

### Problem 1: Minimum Window Substring (LeetCode 76)

*Read this to the candidate:*

> Given two strings `s` and `t`, return the minimum window substring of `s` such that every character in `t` (including duplicates) is included in the window. If there is no such substring, return the empty string `""`.
>
> **Example 1:**
> Input: `s = "ADOBECODEBANC"`, `t = "ABC"`
> Output: `"BANC"`
>
> **Example 2:**
> Input: `s = "a"`, `t = "a"`
> Output: `"a"`
>
> **Example 3:**
> Input: `s = "a"`, `t = "aa"`
> Output: `""` (Both 'a's from t must be present, but s only has one)
>
> **Constraints:**
> - `1 <= len(s), len(t) <= 10^5`
> - `s` and `t` consist of uppercase and lowercase English letters

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| [0:00]-[1:00] | Read Problem 1 | Candidate reads and understands |
| [1:00]-[3:00] | Approach Discussion | Candidate identifies sliding window pattern |
| [3:00]-[18:00] | Implement Problem 1 | Sliding window with character frequency tracking |
| [18:00]-[20:00] | Test & Complexity | Walk through examples, analyze time/space |
| [20:00]-[21:00] | Read Problem 2 | Transition to serialization problem |
| [21:00]-[23:00] | Approach Discussion | Candidate discusses serialization format |
| [23:00]-[40:00] | Implement Problem 2 | Complete serialize and deserialize |
| [40:00]-[45:00] | Testing & Follow-ups | Edge cases, alternative approaches |

### Interviewer Script & Candidate Response - Problem 1

**[0:00] Interviewer:** *"Here's your first problem. Take a moment to read it."*

**[1:00] Candidate:** "This is a sliding window problem. I'll maintain a window [left, right] and expand right until the window contains all characters of t. Then I'll shrink left to minimize the window while still containing all characters. I'll track character frequencies using a map.

The key insight is using a `matched` counter: when the window frequency of a character equals the required frequency, I increment `matched`. When `matched` equals the number of distinct characters in `t`, the window is valid.

Time: O(|s| + |t|) - each character is visited at most twice (once by right pointer, once by left).
Space: O(|s| + |t|) for the frequency maps."

**[3:00] Candidate begins coding:**

```go
// minWindow returns the minimum window substring of s containing all characters of t.
// Uses sliding window with dual-pointer technique and frequency matching.
// Time: O(|s| + |t|), Space: O(|s| + |t|)
func minWindow(s string, t string) string {
    if len(s) == 0 || len(t) == 0 || len(s) < len(t) {
        return ""
    }

    // Count required character frequencies
    required := make(map[byte]int)
    for i := 0; i < len(t); i++ {
        required[t[i]]++
    }

    // Number of distinct characters in t that need to be present in the window
    requiredDistinct := len(required)

    // Current window character frequencies
    window := make(map[byte]int)

    // Number of distinct characters in the window that match the required frequency
    matched := 0

    // Result tracking
    minLen := len(s) + 1
    minLeft := 0

    left := 0
    for right := 0; right < len(s); right++ {
        // Expand window: add s[right]
        ch := s[right]
        window[ch]++

        // Check if this character's frequency now matches the requirement
        if req, ok := required[ch]; ok && window[ch] == req {
            matched++
        }

        // Shrink window from left while it's valid
        for matched == requiredDistinct {
            // Update result if this window is smaller
            windowLen := right - left + 1
            if windowLen < minLen {
                minLen = windowLen
                minLeft = left
            }

            // Remove s[left] from window
            leftCh := s[left]
            window[leftCh]--
            if req, ok := required[leftCh]; ok && window[leftCh] < req {
                matched--
            }
            left++
        }
    }

    if minLen > len(s) {
        return ""
    }

    return s[minLeft : minLeft+minLen]
}
```

**[12:00] Candidate:** "Let me trace through Example 1: `s = 'ADOBECODEBANC'`, `t = 'ABC'`

Required: {A:1, B:1, C:1}, requiredDistinct = 3

- right=0 'A': window={A:1}, matched=1
- right=1 'D': window={A:1, D:1}, matched=1
- right=2 'O': matched=1
- right=3 'B': window={..., B:1}, matched=2
- right=4 'E': matched=2
- right=5 'C': window={..., C:1}, matched=3 → valid!
 - Window 'ADOBEC' len=6, update min=6, minLeft=0
 - Shrink: remove 'A', window[A]=0 < 1, matched=2, left=1
- right=6 'O': matched=2
- right=7 'D': matched=2
- right=8 'E': matched=2
- right=9 'B': matched=2
- right=10 'A': window={A:1}, matched=2... wait, matched was 2 because we lost A. Now A:1 == required 1, so matched=3 → valid!
 - Window s[1:11] = 'DOBECODEBA' len=10, not better than 6
 - Shrink: remove 'D', still matched=3
 - Window s[2:11] = 'OBECODEBA' len=9, not better
 - Continue shrinking until matched < 3
 - Eventually remove 'B', matched=2, stop
- right=11 'N': matched=2
- right=12 'C': window[C] reaches 1, matched=3 → valid!
 - Window = 'BANC' len=4 < 6, update min=4, minLeft=9
 - Shrink: remove 'B', matched=2

Result: s[9:13] = 'BANC' ✓"

**[18:00] Interviewer:** *"What if the characters are Unicode, not just ASCII?"*

**[18:30] Candidate:** "I'd change `map[byte]int` to `map[rune]int` and iterate using `range` (which yields runes, not bytes). The algorithm stays the same, but pointer management changes because rune positions don't map 1:1 to byte positions. I'd track indices differently:

```go
func minWindowUnicode(s string, t string) string {
    required := make(map[rune]int)
    for _, ch := range t {
        required[ch]++
    }

    // Convert s to rune slice for O(1) indexing
    runes := []rune(s)
    window := make(map[rune]int)
    matched := 0
    left := 0
    minLen := len(runes) + 1
    minLeft := 0

    for right := 0; right < len(runes); right++ {
        r := runes[right]
        if count, ok := required[r]; ok {
            window[r]++
            if window[r] == count {
                matched++
            }
        }

        for matched == len(required) {
            if right-left+1 < minLen {
                minLen = right - left + 1
                minLeft = left
            }
            leftR := runes[left]
            if count, ok := required[leftR]; ok {
                if window[leftR] == count {
                    matched--
                }
                window[leftR]--
            }
            left++
        }
    }

    if minLen > len(runes) {
        return ""
    }
    return string(runes[minLeft : minLeft+minLen])
}
```

The time complexity remains O(|s| + |t|) but with rune-level granularity."

### Problem 2: Serialize and Deserialize Binary Tree (LeetCode 297)

**[20:00] Interviewer:** *"Here's the second problem."*

> Design an algorithm to serialize and deserialize a binary tree. Serialization is the process of converting a data structure into a sequence of bytes/string so that it can be stored or transmitted and reconstructed later.
>
> **Example:**
> Input tree:
> ```
> 1
> / \
> 2 3
> / \
> 4 5
> ```
> Serialize: `"1,2,#,#,3,4,#,#,5,#,#"`
> Deserialize: reconstructs the original tree
>
> **Constraints:**
> - The number of nodes in the tree is in the range `[0, 10^4]`
> - `-1000 <= Node.val <= 1000`

**[21:00] Candidate:** "I'll use pre-order traversal (DFS) for serialization. Each null node is represented as '#'. For deserialization, I'll consume tokens from the serialized string using the same pre-order traversal order.

This works because pre-order traversal with null markers uniquely identifies a binary tree - no ambiguity. Alternative approaches: BFS level-order (more intuitive but wastes space for sparse trees), or pre-order + in-order without null markers (requires unique values).

Time: O(n) for both serialize and deserialize.
Space: O(n) for the string and O(h) for the recursion stack where h is the height."

**[23:00] Candidate begins coding:**

```go
package interview

import (
    "strconv"
    "strings"
)

// TreeNode represents a node in a binary tree.
type TreeNode struct {
    Val   int
    Left  *TreeNode
    Right *TreeNode
}

// Codec handles serialization and deserialization of binary trees.
type Codec struct{}

// Serialize encodes a tree to a comma-separated string using pre-order DFS.
// Null nodes are represented as "#".
// Time: O(n), Space: O(n)
func (c *Codec) Serialize(root *TreeNode) string {
    if root == nil {
        return ""
    }

    var buf strings.Builder
    c.serializeHelper(root, &buf)

    // Remove trailing comma
    result := buf.String()
    return result[:len(result)-1]
}

func (c *Codec) serializeHelper(node *TreeNode, buf *strings.Builder) {
    if node == nil {
        buf.WriteString("#,")
        return
    }

    // Pre-order: root, left, right
    buf.WriteString(strconv.Itoa(node.Val))
    buf.WriteByte(',')
    c.serializeHelper(node.Left, buf)
    c.serializeHelper(node.Right, buf)
}

// Deserialize decodes a string back to a binary tree.
// Time: O(n), Space: O(n)
func (c *Codec) Deserialize(data string) *TreeNode {
    if data == "" {
        return nil
    }

    tokens := strings.Split(data, ",")
    idx := 0
    return c.deserializeHelper(tokens, &idx)
}

func (c *Codec) deserializeHelper(tokens []string, idx *int) *TreeNode {
    if *idx >= len(tokens) {
        return nil
    }

    token := tokens[*idx]
    *idx++

    if token == "#" {
        return nil
    }

    val, _ := strconv.Atoi(token)
    node := &TreeNode{Val: val}
    node.Left = c.deserializeHelper(tokens, idx)
    node.Right = c.deserializeHelper(tokens, idx)

    return node
}
```

**[32:00] Candidate:** "Let me trace the example:

Serialize tree:
```
    1
   / \
  2   3
     / \
    4   5
```
Pre-order: visit(1) → visit(2) → visit(nil)='#' → visit(nil)='#' → visit(3) → visit(4) → visit(nil)='#' → visit(nil)='#' → visit(5) → visit(nil)='#' → visit(nil)='#'
Output: `'1,2,#,#,3,4,#,#,5,#,#'` ✓

Deserialize `'1,2,#,#,3,4,#,#,5,#,#'`:
Tokens: [1, 2, #, #, 3, 4, #, #, 5, #, #]
- idx=0: token='1', create node(1)
 - Left: idx=1: token='2', create node(2)
 - Left: idx=2: token='#', return nil
 - Right: idx=3: token='#', return nil
 - Right: idx=4: token='3', create node(3)
 - Left: idx=5: token='4', create node(4)
 - Left: idx=6: '#', nil
 - Right: idx=7: '#', nil
 - Right: idx=8: token='5', create node(5)
 - Left: idx=9: '#', nil
 - Right: idx=10: '#', nil
Reconstructed tree matches original ✓"

**[36:00] Interviewer:** *"What if the tree is very deep - say, a million nodes in a completely skewed tree? What's the problem with your recursive approach?"*

**[36:30] Candidate:** "Stack overflow. A million-deep recursion would exceed Go's default goroutine stack limit (1GB, but the practical limit depends on available memory and each frame's size). I'd convert to an iterative approach using an explicit stack:

```go
package interview

import (
    "strconv"
    "strings"
)

// Codec handles iterative serialization and deserialization.
type Codec struct{}

// TreeNode represents a node in a binary tree.
type TreeNode struct {
    Val   int
    Left  *TreeNode
    Right *TreeNode
}

// SerializeIterative uses an explicit stack to avoid recursion depth limits.
func (c *Codec) SerializeIterative(root *TreeNode) string {
    if root == nil {
        return ""
    }

    var buf strings.Builder
    stack := []*TreeNode{root}

    for len(stack) > 0 {
        // Pop
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]

        if node == nil {
            buf.WriteString("#,")
            continue
        }

        buf.WriteString(strconv.Itoa(node.Val))
        buf.WriteByte(',')

        // Push right first, then left (so left is processed first - pre-order)
        stack = append(stack, node.Right)
        stack = append(stack, node.Left)
    }

    result := buf.String()
    return result[:len(result)-1]
}

// DeserializeIterative reconstructs a tree without recursion.
func (c *Codec) DeserializeIterative(data string) *TreeNode {
    if data == "" {
        return nil
    }

    tokens := strings.Split(data, ",")
    if len(tokens) == 0 || tokens[0] == "#" {
        return nil
    }

    rootVal, _ := strconv.Atoi(tokens[0])
    root := &TreeNode{Val: rootVal}

    // Stack holds (node, isLeftDone) pairs
    type entry struct {
        node     *TreeNode
        leftDone bool
    }
    stack := []entry{{node: root, leftDone: false}}

    for i := 1; i < len(tokens); i++ {
        token := tokens[i]

        for len(stack) > 0 && stack[len(stack)-1].leftDone {
            // This node needs its right child
            top := &stack[len(stack)-1]
            if token == "#" {
                top.node.Right = nil
                stack = stack[:len(stack)-1] // Pop, both children done
                i++
                if i >= len(tokens) {
                    break
                }
                token = tokens[i]
                continue
            }
            val, _ := strconv.Atoi(token)
            child := &TreeNode{Val: val}
            top.node.Right = child
            stack = stack[:len(stack)-1] // Pop parent
            stack = append(stack, entry{node: child, leftDone: false})
            break
        }

        if len(stack) > 0 && !stack[len(stack)-1].leftDone {
            top := &stack[len(stack)-1]
            top.leftDone = true

            if token == "#" {
                top.node.Left = nil
                continue
            }
            val, _ := strconv.Atoi(token)
            child := &TreeNode{Val: val}
            top.node.Left = child
            stack = append(stack, entry{node: child, leftDone: false})
        }
    }

    return root
}
```

Honestly, the iterative deserialize is tricky to get right. In practice, for the interview I'd mention the stack overflow risk and offer the iterative serialize (which is straightforward) while noting the deserialize iterative version is more complex and I'd want to test it thoroughly."

**[40:00] Interviewer:** *"What about a compact binary serialization format instead of strings?"*

**[40:30] Candidate:** "For production use, I'd use a binary format:

- Each node: 4 bytes for the int value + 1 bit flags for left/right child existence
- Use variable-length encoding (varint) for values to save space on small numbers
- This reduces the serialized size from O(n * avg_digits) to O(n * 4) bytes
- For transmission, I'd also add a version byte header for forward compatibility

Go's `encoding/binary` and `encoding/gob` packages make this straightforward. Gob in particular handles recursive structures natively."

### Scoring Rubric

| Dimension | 1 (Poor) | 3 (Meets Bar) | 5 (Exceptional) |
|-----------|----------|----------------|------------------|
| **Problem 1: Approach** | Cannot identify sliding window | Identifies sliding window, explains frequency tracking | Immediately identifies optimal approach with matched-count optimization |
| **Problem 1: Implementation** | Major bugs, doesn't handle edge cases | Working solution, handles basic cases | Clean, bug-free, handles Unicode follow-up |
| **Problem 1: Speed** | >22 minutes | 15-20 minutes | <15 minutes with thorough testing |
| **Problem 2: Approach** | Cannot choose a serialization strategy | Pre-order with null markers, correct reasoning | Discusses multiple strategies, trade-offs, chooses optimal |
| **Problem 2: Implementation** | Serialize works but deserialize fails | Both functions correct | Handles all edge cases, discusses iterative alternative |
| **Problem 2: Speed** | >22 minutes | 15-20 minutes | <15 minutes with testing |
| **Communication** | Silent coding | Explains approach before coding | Narrates throughout, proactive about edge cases |
| **Follow-ups** | Cannot answer | Answers correctly | Provides deep insights (Unicode handling, binary format, iterative conversion) |

**Scoring thresholds:**
- **Strong Hire:** Both problems solved correctly, average ≥ 4.0
- **Hire:** Both problems solved, average ≥ 3.0
- **Lean No Hire:** Only one problem fully solved
- **No Hire:** Neither problem solved correctly


### Junior → FAANG: Google L5 Coding Mock: Minimum Window Substring

Minimum Window Substring (LeetCode 76) is a sliding window problem. The approach: maintain a window with two pointers (left and right), expand the right pointer until all characters in the target are covered, then contract the left pointer to minimize the window size while maintaining coverage. Use a frequency map for the target and a counter of satisfied characters to determine coverage in O(1) per step, giving an overall O(n + m) solution. Practice narrating the shrinking condition clearly, because it is the subtlest part of the algorithm.

### Senior @ FAANG: Minimum Window at the L5/L6 Bar: Generalization and Amortized Analysis

At the L5/L6 level, the Minimum Window discussion includes amortized complexity analysis: each character is added to the window at most once and removed at most once, giving O(n) amortized for the sliding window movement, plus O(m) for initialization. The bar-raiser may ask for a generalization: 'what if the target is a multiset and we need to find the minimum window containing all elements with their required frequencies?', which the standard sliding window solution already handles. A more interesting generalization is: 'what if the input is a stream and you need to report the minimum window in real time as new characters arrive?'. This requires an online algorithm that maintains the window state incrementally, which the standard approach already supports with minor adaptation. Code quality at L5/L6 includes handling the empty target case and the case where no valid window exists, with clear return values for both.

---
