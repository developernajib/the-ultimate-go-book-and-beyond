## 78B.9 The Trie Pattern

A trie (prefix tree) stores strings as paths from root to leaf, where each edge represents one character. This structure enables O(m) lookup, insertion, and prefix queries regardless of how many strings are stored, something a hash map cannot match for prefix operations. The shared prefix structure is the key advantage: inserting "apple", "app", and "application" reuses the common `a→p→p` path, making tries ideal for autocomplete, spell-checking, and multi-word board search problems where pruning by prefix eliminates entire search branches.

```
┌──────────────────────────────────────────────────────────────────┐
│                      TRIE PATTERN                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                     (root)                                       │
│                    /      \                                      │
│                   a        b                                     │
│                  /          \                                    │
│                 p            a                                   │
│                / \            \                                  │
│               p*  t*           t*                                │
│              /                                                   │
│             l                                                    │
│            / \                                                   │
│           e*  y*                                                 │
│                                                                  │
│  * marks isEnd. Words stored: app, apt, apple, apply, bat        │
│  Note "app" is both a complete word and a prefix of "apple",     │
│  which is exactly why isEnd cannot mean "leaf".                  │
│                                                                  │
│  Use: Prefix search, autocomplete, word search in grid,          │
│       spell checker, IP routing                                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Trie Implementation

This trie implementation uses a fixed-size `[26]*TrieNode` children array indexed by character offset, trading memory for O(1) child access. The optional `word` field on each node stores the full word at the end-of-word node, enabling word retrieval during search without reconstructing the string from the path.

```go
type TrieNode struct {
    children [26]*TrieNode
    isEnd    bool
    word     string // optional: store the full word at leaf
}

type Trie struct {
    root *TrieNode
}

func NewTrie() *Trie {
    return &Trie{root: &TrieNode{}}
}

func (t *Trie) Insert(word string) {
    node := t.root
    for _, ch := range word {
        idx := ch - 'a'
        if node.children[idx] == nil {
            node.children[idx] = &TrieNode{}
        }
        node = node.children[idx]
    }
    node.isEnd = true
    node.word = word
}

func (t *Trie) Search(word string) bool {
    node := t.root
    for _, ch := range word {
        idx := ch - 'a'
        if node.children[idx] == nil {
            return false
        }
        node = node.children[idx]
    }
    return node.isEnd
}

func (t *Trie) StartsWith(prefix string) bool {
    node := t.root
    for _, ch := range prefix {
        idx := ch - 'a'
        if node.children[idx] == nil {
            return false
        }
        node = node.children[idx]
    }
    return true
}
```

---

### Problem 1: Implement Trie (LC 208)

**Problem:** Implement a trie with insert, search, and startsWith.

**Approach:** The implementation above is the direct solution.

```go
// The Trie implementation above is the complete solution to LC 208.
// Design decisions worth stating out loud:
// 1. [26]*TrieNode for lowercase English letters: O(1) child access, no hashing
// 2. isEnd distinguishes "a word ends here" from "a word passes through here"
// 3. No delete needed for this problem, which is why nothing refcounts children
```

**Time Complexity:** O(m) for all operations, where m is the word or prefix length. Independent of how many words are stored, which is the property a hash map cannot match for prefix queries.
**Space Complexity:** O(26 · N) pointers where N is the total number of nodes, bounded by the total characters inserted. Shared prefixes collapse, so this is a worst case, not a typical case.

**Edge cases:**
- Search for a prefix that exists but is not a complete word → false. This is the whole reason `isEnd` exists
- StartsWith for a complete word → true
- Empty string: `Insert("")` marks the root as a word end and `Search("")` then returns true. Consistent, but worth confirming the interviewer wants that
- Any character outside `a` to `z` panics on the `ch - 'a'` index. The fixed array buys speed by assuming the alphabet. Name the assumption before you are asked

---

### Problem 2: Word Search II (LC 212)

**Problem:** Given an `m x n` board of characters and a list of words, find all words that can be formed by sequentially adjacent cells (no cell reused per word).

**Approach:** Build a trie from the word list. DFS from each cell, following trie branches. This prunes the search dramatically compared to searching for each word independently.

```go
func findWords(board [][]byte, words []string) []string {
    trie := NewTrie()
    for _, w := range words {
        trie.Insert(w)
    }

    rows, cols := len(board), len(board[0])
    result := []string{}
    directions := [4][2]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}

    var dfs func(r, c int, node *TrieNode)
    dfs = func(r, c int, node *TrieNode) {
        if r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] == '#' {
            return
        }

        ch := board[r][c]
        child := node.children[ch-'a']
        if child == nil {
            return // no word in trie with this prefix
        }

        if child.isEnd {
            result = append(result, child.word)
            child.isEnd = false // avoid duplicates
        }

        board[r][c] = '#' // mark visited
        for _, d := range directions {
            dfs(r+d[0], c+d[1], child)
        }
        board[r][c] = ch // restore
    }

    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            dfs(r, c, trie.root)
        }
    }

    return result
}
```

**Time Complexity:** O(m · n · 4^L) where L is the maximum word length. The bound is loose: the `child == nil` test kills a branch the moment the path stops spelling a prefix of any word, so real inputs explore a small fraction of it.
**Space Complexity:** O(total characters in words) for the trie.

Two details carry the solution. Setting `child.isEnd = false` after a hit is deduplication by mutation: the same word reachable by a second path can no longer be reported, so `result` needs no set. It also means the trie is consumed by the search and a second call to `findWords` on the same trie would return nothing. Rebuild it, or track found words separately, if the trie must survive.

The second is the `board[r][c] = '#'` and restore pair. It enforces "no cell reused within one word" and must be undone on *every* exit path from the marked region, which is why the restore sits after the direction loop rather than inside it.

A further optimization exists and is worth mentioning in an interview even if you do not write it: once a trie node has been fully consumed (no children and not an end), it can be unlinked from its parent so later cells never descend into it. That is what prunes a dead dictionary branch permanently rather than re-walking it from each starting cell.

**Edge cases:**
- Word not constructible from the board
- Same word constructible from multiple paths → included once, via the `isEnd` reset
- Single cell board
- Words sharing prefixes, which is exactly where the trie pays for itself

---

### Problem 3: Design Add and Search Words Data Structure (LC 211)

**Problem:** Design a data structure that supports adding words and searching with `.` as wildcard for any character.

**Approach:** Trie with modified search that branches to all children when encountering `.`.

```go
type WordDictionary struct {
    root *TrieNode
}

func Constructor() WordDictionary {
    return WordDictionary{root: &TrieNode{}}
}

func (wd *WordDictionary) AddWord(word string) {
    node := wd.root
    for _, ch := range word {
        idx := ch - 'a'
        if node.children[idx] == nil {
            node.children[idx] = &TrieNode{}
        }
        node = node.children[idx]
    }
    node.isEnd = true
}

func (wd *WordDictionary) Search(word string) bool {
    return wd.searchHelper(wd.root, word, 0)
}

func (wd *WordDictionary) searchHelper(node *TrieNode, word string, idx int) bool {
    if idx == len(word) {
        return node.isEnd
    }

    ch := word[idx]
    if ch == '.' {
        // Try all possible children
        for _, child := range node.children {
            if child != nil && wd.searchHelper(child, word, idx+1) {
                return true
            }
        }
        return false
    }

    child := node.children[ch-'a']
    if child == nil {
        return false
    }
    return wd.searchHelper(child, word, idx+1)
}
```

**Time Complexity:** O(m) for addWord, O(26^m) worst case for search with all dots, O(m) for search without dots.
**Space Complexity:** O(total characters) for the trie.

**Edge cases:**
- Search "..." → matches any 3-letter word
- Search with no wildcards → standard trie search
- Empty word

---

### Junior → FAANG: Trie Implementation Pitfalls

The most common junior mistake in trie implementation is conflating "end of a word" with "leaf node." A node can be the end of one word and also a prefix of another. The `isEnd` boolean flag must be set at the node corresponding to the last character of a word, independent of whether that node has children. If you delete the `isEnd` flag on insert, you corrupt the trie for words that are prefixes of other words (e.g., inserting "app" and "apple" must result in the 'p' node having `isEnd = true` even though it has a child 'l').

Memory layout choice: using `[26]*TrieNode` (fixed array) for lowercase English letters gives O(1) child access by index (`c - 'a'`) and avoids hash map overhead, which matters in an interview where you want simple, fast code. Using `map[rune]*TrieNode` handles arbitrary alphabets (Unicode, digits, mixed) at the cost of hash map overhead. State which you are using and why.

The DFS search for Word Search II (find all words from a dictionary on a board) is a common hard interview problem. The key insight is to build the trie from the word dictionary and then DFS from each cell on the board, pruning entire branches when the current character sequence is not a prefix of any remaining word. Without the trie, you would need to restart a search for each word independently, giving O(W * rows * cols * 4^L) where W is word count and L is max word length. The trie reduces this to a single board traversal of O(rows * cols * 4^L) with W amortized across all paths.

Entry-level signal: implementing `StartsWith` correctly. Candidates who implement `Search` and then copy-paste it for `StartsWith` without removing the `isEnd` check often get it right accidentally but cannot explain why the check differs. Explain the difference: `Search` requires reaching a node with `isEnd = true`. `StartsWith` only requires reaching the node corresponding to the last character of the prefix.

### Senior @ FAANG: Tries in Production Search and Routing Infrastructure

Tries underlie a significant fraction of internet infrastructure. DNS resolution is a trie traversal over hierarchical labels (reading right to left: `com -> google -> www`). IP routing tables are implemented as PATRICIA tries (compressed radix tries) where each node stores a prefix rather than a single character. HTTP routing in web frameworks (matching `/api/v1/users/:id`) is a trie over URL path segments with wildcard nodes.

In full-text search, the inverted index's term dictionary is often stored as an FST (finite state transducer), which is a compressed trie variant that also encodes the mapping from term to postings list offset. Lucene (and by extension Elasticsearch) uses FSTs for its term dictionary. Understanding tries lets you reason about FST construction costs, memory footprint, and the performance implications of dictionary size on query latency.

ADR consideration: in-memory tries have poor cache locality, because following a child pointer is a dependent load that the prefetcher cannot anticipate, so each level of descent risks a cache miss. For read-heavy workloads over large dictionaries, a double-array trie or a succinct representation that encodes the structure in bit arrays cuts memory substantially and removes the pointer chasing, at the cost of being expensive or impossible to update in place. That tradeoff, fast immutable reads against cheap mutation, is the actual decision. A pointer-based trie is the right default while the dictionary is small and changes often. Measure before migrating: the node overhead is easy to compute up front, and it is usually what forces the change.

Bar-raiser signal: the candidate quantifies the memory overhead of a pointer-based trie rather than hand-waving it. Every node carries a 26-pointer array costing 208 bytes on a 64-bit machine whether it has one child or twenty-six, so a dictionary of long, low-branching strings spends nearly all of its memory on nil pointers. From that number the alternatives follow: map-based children, or a sorted slice of (character, child) pairs that trades O(1) indexing for a short scan and much smaller nodes. They also explain how Aho-Corasick extends the trie with failure links to match many patterns in one pass in O(n + m + z) time, where z is the number of matches, and note that this is the structure behind multi-pattern scanners in intrusion detection and log matching.
