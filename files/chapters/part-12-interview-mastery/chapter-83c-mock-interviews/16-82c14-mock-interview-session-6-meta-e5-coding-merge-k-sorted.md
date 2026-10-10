## 83C.14 Mock Interview Session 6: Meta E5 Coding - Merge K Sorted Lists & Word Break

### Interviewer Briefing

**Company style:** Meta (Facebook). E5 (Senior Software Engineer). Meta coding interviews emphasize speed, working code, and ability to handle two medium-hard problems in 45 minutes. The interviewer expects quick pattern recognition, clean implementation, and efficient bug-free code. Less emphasis on discussing multiple approaches - Meta interviewers want to see you code.

**Level:** E5 (Senior Software Engineer)

**Interview duration:** 45 minutes (two problems)

**Key evaluation criteria:** Speed, correctness, code quality, ability to handle follow-ups, communication during coding.

### Problem 1: Merge K Sorted Lists (LeetCode 23)

*Read this to the candidate (or read it yourself and start the timer):*

> You are given an array of `k` linked lists, each sorted in ascending order. Merge all the linked lists into one sorted linked list and return it.
>
> **Example 1:**
> Input: `lists = [[1,4,5],[1,3,4],[2,6]]`
> Output: `[1,1,2,3,4,4,5,6]`
>
> **Example 2:**
> Input: `lists = []`
> Output: `[]`
>
> **Example 3:**
> Input: `lists = [[]]`
> Output: `[]`
>
> **Constraints:**
> - `k == len(lists)`
> - `0 <= k <= 10^4`
> - `0 <= len(lists[i]) <= 500`
> - `-10^4 <= lists[i][j] <= 10^4`
> - Each `lists[i]` is sorted in ascending order
> - Total number of nodes across all lists will not exceed `10^4`

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| [0:00]-[1:00] | Read Problem 1 | Candidate reads the problem |
| [1:00]-[2:00] | Quick Approach | Candidate states approach (min-heap or divide-and-conquer) |
| [2:00]-[15:00] | Implement Problem 1 | Clean Go implementation with min-heap |
| [15:00]-[17:00] | Test & Debug Problem 1 | Walk through Example 1, check edge cases |
| [17:00]-[18:00] | Follow-up Discussion | Complexity analysis, alternative approaches |
| [18:00]-[19:00] | Read Problem 2 | Candidate reads Word Break |
| [19:00]-[20:00] | Quick Approach | Candidate identifies DP approach |
| [20:00]-[38:00] | Implement Problem 2 | DP solution with optimization |
| [38:00]-[42:00] | Test & Debug Problem 2 | Walk through examples, edge cases |
| [42:00]-[45:00] | Follow-up Questions | Extensions and optimizations |

### Interviewer Script & Candidate Response - Problem 1

**[0:00] Interviewer:** *"Let's start with our first problem. Take a moment to read it."*

**[1:00] Candidate:** "I'll use a min-heap approach. I'll push the head of each non-nil list into a heap, then repeatedly extract the minimum and push that node's next pointer. Time complexity: O(N log k) where N is total nodes and k is number of lists. Space: O(k) for the heap. Let me code this up."

**[2:00] Candidate begins coding:**

```go
package main

import "container/heap"

// ListNode represents a node in a singly-linked list.
type ListNode struct {
    Val  int
    Next *ListNode
}

// MinHeap implements heap.Interface for ListNode pointers.
type MinHeap []*ListNode

func (h MinHeap) Len() int            { return len(h) }
func (h MinHeap) Less(i, j int) bool   { return h[i].Val < h[j].Val }
func (h MinHeap) Swap(i, j int)        { h[i], h[j] = h[j], h[i] }

func (h *MinHeap) Push(x interface{}) {
    *h = append(*h, x.(*ListNode))
}

func (h *MinHeap) Pop() interface{} {
    old := *h
    n := len(old)
    node := old[n-1]
    old[n-1] = nil // avoid memory leak
    *h = old[:n-1]
    return node
}

// mergeKLists merges k sorted linked lists using a min-heap.
// Time: O(N log k), Space: O(k)
func mergeKLists(lists []*ListNode) *ListNode {
    h := &MinHeap{}
    heap.Init(h)

    // Push the head of each non-nil list
    for _, head := range lists {
        if head != nil {
            heap.Push(h, head)
        }
    }

    dummy := &ListNode{}
    current := dummy

    for h.Len() > 0 {
        // Extract the node with the smallest value
        minNode := heap.Pop(h).(*ListNode)
        current.Next = minNode
        current = current.Next

        // If this node has a next, push it into the heap
        if minNode.Next != nil {
            heap.Push(h, minNode.Next)
        }
    }

    return dummy.Next
}
```

**[10:00] Candidate:** "Let me trace through Example 1:
- Initial heap: [1(list0), 1(list1), 2(list2)]
- Pop 1(list0), push 4 → heap: [1(list1), 2(list2), 4]
- Pop 1(list1), push 3 → heap: [2(list2), 3, 4]
- Pop 2(list2), push 6 → heap: [3, 4, 6]
- Pop 3, push 4 → heap: [4, 4, 6]
- Pop 4(list0), push 5 → heap: [4, 5, 6]
- Pop 4(list1), no next → heap: [5, 6]
- Pop 5, no next → heap: [6]
- Pop 6, no next → heap: []
- Result: 1→1→2→3→4→4→5→6 ✓

Edge cases: empty lists array returns nil (heap is empty, loop doesn't execute). Array with empty lists - nil heads are filtered out."

**[15:00] Interviewer:** *"Looks good. What's the alternative approach and when would you prefer it?"*

**[15:30] Candidate:** "Divide and conquer - recursively merge pairs of lists. Same O(N log k) time but O(1) extra space if done iteratively. I'd prefer it when k is very large and we want to minimize heap overhead, or when the lists are stored on disk and we want to minimize random access."

### Interviewer Script & Candidate Response - Problem 2: Word Break (LeetCode 139)

**[18:00] Interviewer:** *"Great, let's move to the second problem."*

> Given a string `s` and a dictionary of strings `wordDict`, return `true` if `s` can be segmented into a space-separated sequence of one or more dictionary words.
>
> **Note:** The same word in the dictionary may be reused multiple times in the segmentation.
>
> **Example 1:**
> Input: `s = "leetcode"`, `wordDict = ["leet","code"]`
> Output: `true` (Explanation: "leetcode" can be segmented as "leet code")
>
> **Example 2:**
> Input: `s = "applepenapple"`, `wordDict = ["apple","pen"]`
> Output: `true`
>
> **Example 3:**
> Input: `s = "catsandog"`, `wordDict = ["cats","dog","sand","and","cat"]`
> Output: `false`
>
> **Constraints:**
> - `1 <= len(s) <= 300`
> - `1 <= len(wordDict) <= 1000`
> - `1 <= len(wordDict[i]) <= 20`
> - `s` and `wordDict[i]` consist of only lowercase English letters
> - All strings in `wordDict` are unique

**[19:00] Candidate:** "This is a classic DP problem. I'll define `dp[i]` as true if `s[0:i]` can be segmented into dictionary words. For each position `i`, I check all possible last words: if `dp[j]` is true and `s[j:i]` is in the dictionary, then `dp[i]` is true.

Time: O(n^2 * m) naively, but I can optimize by limiting the inner loop to the maximum word length. With `max_word_len = 20`, it's O(n * max_word_len * avg_word_len) for the substring check. Space: O(n + total_dict_size)."

**[20:00] Candidate begins coding:**

```go
// wordBreak returns true if s can be segmented into dictionary words.
// Uses bottom-up DP with hash set for O(1) word lookups.
// Time: O(n * maxWordLen), Space: O(n + dictSize)
func wordBreak(s string, wordDict []string) bool {
    // Build hash set for O(1) lookup
    wordSet := make(map[string]bool, len(wordDict))
    maxLen := 0
    for _, word := range wordDict {
        wordSet[word] = true
        if len(word) > maxLen {
            maxLen = len(word)
        }
    }

    n := len(s)
    // dp[i] = true means s[0:i] can be segmented
    dp := make([]bool, n+1)
    dp[0] = true // empty string is always valid

    for i := 1; i <= n; i++ {
        // Only check substrings of length up to maxLen
        for j := max(0, i-maxLen); j < i; j++ {
            if dp[j] && wordSet[s[j:i]] {
                dp[i] = true
                break // No need to check further
            }
        }
    }

    return dp[n]
}

func max(a, b int) int {
    if a > b {
        return a
    }
    return b
}
```

**[28:00] Candidate:** "Let me trace Example 1: `s = 'leetcode'`, `wordDict = ['leet', 'code']`
- dp = [T, F, F, F, F, F, F, F, F]
- i=1: check s[0:1]='l' → not in dict
- i=2: check s[0:2]='le', s[1:2]='e' → no
- i=3: check s[0:3]='lee', s[1:3]='ee', s[2:3]='e' → no
- i=4: check s[0:4]='leet' → dp[0]=true, 'leet' in dict → dp[4]=true
- i=5: check s[1:5]='eetc'... s[4:5]='c' → no
- i=6: check s[2:6]='etco'... → no
- i=7: check s[3:7]='tcod'... → no
- i=8: check s[4:8]='code' → dp[4]=true, 'code' in dict → dp[8]=true ✓

Example 3: `s = 'catsandog'`, dp[3]=true ('cat'), dp[4]=true ('cats'), dp[7]=true ('cat'+'sand' or 'cats'+'and'), but dp[9] can't be reached because 'og' and 'dog' from position 7 gives 'og', and from 6 gives 'dog' but dp[6] is false."

**[35:00] Interviewer:** *"What if I also want to return all valid segmentations, not just true/false?"*

**[35:30] Candidate:** "That's Word Break II (LeetCode 140). I'd use backtracking with memoization:

```go
// wordBreakII returns all valid segmentations of s using dictionary words.
// Uses top-down DP with memoization to avoid recomputing subproblems.
func wordBreakII(s string, wordDict []string) []string {
    wordSet := make(map[string]bool, len(wordDict))
    maxLen := 0
    for _, word := range wordDict {
        wordSet[word] = true
        if len(word) > maxLen {
            maxLen = len(word)
        }
    }

    memo := make(map[int][]string)
    return backtrack(s, 0, wordSet, maxLen, memo)
}

// backtrack returns all segmentations of s[start:].
func backtrack(s string, start int, wordSet map[string]bool, maxLen int, memo map[int][]string) []string {
    if cached, ok := memo[start]; ok {
        return cached
    }

    if start == len(s) {
        return []string{""}
    }

    var results []string
    end := min(start+maxLen, len(s))

    for i := start + 1; i <= end; i++ {
        word := s[start:i]
        if !wordSet[word] {
            continue
        }

        suffixes := backtrack(s, i, wordSet, maxLen, memo)
        for _, suffix := range suffixes {
            if suffix == "" {
                results = append(results, word)
            } else {
                results = append(results, word+" "+suffix)
            }
        }
    }

    memo[start] = results
    return results
}

func min(a, b int) int {
    if a < b {
        return a
    }
    return b
}
```

Worst case is exponential in the number of segmentations (e.g., `s = 'aaa...a'`, `dict = ['a', 'aa', 'aaa', ...]`), but memoization ensures each subproblem is solved once. The output size itself can be exponential."

**[40:00] Interviewer:** *"If the dictionary is very large (millions of words), how would you optimize the lookup?"*

**[40:30] Candidate:** "I'd replace the hash set with a Trie. The Trie lets me check all dictionary prefixes of `s[j:]` in a single traversal, avoiding redundant string hashing:

```go
// TrieNode supports efficient prefix-based dictionary lookup.
type TrieNode struct {
    children [26]*TrieNode
    isWord   bool
}

// Insert adds a word to the trie.
func (t *TrieNode) Insert(word string) {
    node := t
    for _, ch := range word {
        idx := ch - 'a'
        if node.children[idx] == nil {
            node.children[idx] = &TrieNode{}
        }
        node = node.children[idx]
    }
    node.isWord = true
}

// wordBreakTrie uses a Trie for efficient dictionary matching.
func wordBreakTrie(s string, wordDict []string) bool {
    root := &TrieNode{}
    for _, word := range wordDict {
        root.Insert(word)
    }

    n := len(s)
    dp := make([]bool, n+1)
    dp[0] = true

    for i := 0; i < n; i++ {
        if !dp[i] {
            continue
        }
        node := root
        for j := i; j < n; j++ {
            idx := s[j] - 'a'
            if node.children[idx] == nil {
                break // No words with this prefix
            }
            node = node.children[idx]
            if node.isWord {
                dp[j+1] = true
            }
        }
    }

    return dp[n]
}
```

This reduces the inner loop's string comparison cost from O(word_len) per check to O(1) per character traversal."

### Scoring Rubric

| Dimension | 1 (Poor) | 3 (Meets Bar) | 5 (Exceptional) |
|-----------|----------|----------------|------------------|
| **Problem 1: Approach** | Cannot identify heap or D&C approach | Identifies optimal approach, explains complexity | Immediately identifies approach, discusses trade-offs between heap and D&C |
| **Problem 1: Implementation** | Code has major bugs, doesn't compile | Working solution with minor issues | Clean, bug-free, idiomatic Go, handles edge cases |
| **Problem 1: Speed** | >20 minutes for Problem 1 | 12-18 minutes including testing | <12 minutes with thorough testing |
| **Problem 2: Approach** | Cannot identify DP formulation | Correct DP formulation with complexity analysis | Identifies optimization (maxLen bound), discusses Trie alternative |
| **Problem 2: Implementation** | Code has major bugs or incorrect DP | Working DP solution | Clean, optimized, handles all edge cases |
| **Problem 2: Speed** | >25 minutes for Problem 2 | 15-22 minutes including testing | <15 minutes with thorough testing |
| **Communication** | Codes silently, doesn't explain | Explains approach before coding | Narrates thinking throughout, clear and concise |
| **Follow-ups** | Cannot answer follow-up questions | Answers follow-ups correctly | Provides insightful extensions (Word Break II, Trie optimization) |

**Scoring thresholds:**
- **Strong Hire:** Both problems solved correctly, average ≥ 4.0
- **Hire:** Both problems solved, average ≥ 3.0
- **Lean No Hire:** Only one problem fully solved
- **No Hire:** Neither problem solved correctly


### Junior → FAANG: Meta E5 Coding Mock: Merge K Sorted Lists

Merge K sorted lists is a classic problem that tests heap usage, iterator patterns, and asymptotic analysis. The optimal solution uses a min-heap of size K, extracting the minimum element across all lists in O(log K) per step, for an overall time complexity of O(N log K) where N is the total number of elements. The sub-optimal solution merges lists two at a time for O(N * K) time. Practice stating the time and space complexity clearly before coding and reasoning through why the heap approach achieves the optimal bound.

### Senior @ FAANG: Merge K Sorted: L5/L6 Follow-Up Depth and Generalization

At the E5/E6 level, the coding interview for this problem includes follow-up questions that test generalization. The interviewer may ask: 'what if the lists are not in memory but are streams from network connections?', which changes the data access pattern and requires a generator/iterator abstraction rather than indexed access. Or: 'what if K is very large (10 million sources)?', which breaks the single-threaded heap approach and requires a tree of merge operations or a distributed merge strategy. The L6 signal is the ability to recognize that the algorithm is correct but the constraint has changed, identify the new bottleneck (memory for 10M heap entries, or network round-trips for remote sources), and propose a principled adaptation. Code quality at the E5/E6 level also includes error handling (what if a list iterator returns an error?), which is often missed by candidates who focus only on the happy path.

---
