## 78.1 Trie (Prefix Tree)

A trie, also called a prefix tree, is a tree-shaped data structure that stores strings by decomposing each one character per level, sharing common prefixes among multiple words. This prefix sharing makes the trie extremely efficient for lookup, insertion, and prefix-matching operations, all of which run in O(m) time proportional to the string length rather than the number of stored words. The diagram below illustrates how the words "app", "apple", "apply", "apt", and "bat" share branches at the top of the tree.

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRIE STRUCTURE                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Words: ["app", "apple", "apply", "apt", "bat"]                 │
│                                                                 │
│                        (root)                                   │
│                       /      \                                  │
│                      a        b                                 │
│                     /          \                                │
│                    p            a                               │
│                   / \            \                              │
│                  p*  t*           t*                            │
│                 / \                                             │
│                l   e*                                           │
│               /                                                 │
│              y*                                                 │
│                                                                 │
│  * = end of word                                                │
│                                                                 │
│  Operations:                                                    │
│  • Insert: O(m) where m = word length                           │
│  • Search: O(m)                                                 │
│  • Prefix search: O(m)                                          │
│  • Space: O(ALPHABET_SIZE * n * m) worst case                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Basic Trie Implementation

A trie stores strings by character at each node level, where each node holds an array of child pointers indexed by character. The `IsEnd` flag marks nodes that are the terminal character of a complete word, allowing the trie to distinguish between prefixes and full words without storing any additional metadata.

```go
package trie

// TrieNode represents a node in the trie
type TrieNode struct {
    children map[rune]*TrieNode
    isEnd    bool
    word     string // Optional: store the word for easy retrieval
}

// Trie implements a prefix tree
type Trie struct {
    root *TrieNode
}

// NewTrie creates a new trie
func NewTrie() *Trie {
    return &Trie{
        root: &TrieNode{children: make(map[rune]*TrieNode)},
    }
}

// Insert adds a word to the trie
// Time: O(m) where m is word length
func (t *Trie) Insert(word string) {
    node := t.root
    for _, ch := range word {
        if node.children[ch] == nil {
            node.children[ch] = &TrieNode{children: make(map[rune]*TrieNode)}
        }
        node = node.children[ch]
    }
    node.isEnd = true
    node.word = word
}

// Search checks if a word exists in the trie
// Time: O(m)
func (t *Trie) Search(word string) bool {
    node := t.findNode(word)
    return node != nil && node.isEnd
}

// StartsWith checks if any word starts with given prefix
// Time: O(m)
func (t *Trie) StartsWith(prefix string) bool {
    return t.findNode(prefix) != nil
}

// findNode returns the node for a given string
func (t *Trie) findNode(s string) *TrieNode {
    node := t.root
    for _, ch := range s {
        if node.children[ch] == nil {
            return nil
        }
        node = node.children[ch]
    }
    return node
}

// GetWordsWithPrefix returns all words with given prefix
func (t *Trie) GetWordsWithPrefix(prefix string) []string {
    result := []string{}
    node := t.findNode(prefix)
    if node == nil {
        return result
    }
    t.collectWords(node, &result)
    return result
}

func (t *Trie) collectWords(node *TrieNode, result *[]string) {
    if node.isEnd {
        *result = append(*result, node.word)
    }
    for _, child := range node.children {
        t.collectWords(child, result)
    }
}

// Delete removes a word from the trie.
// It converts to []rune first, because Insert walks the string with
// range, which yields runes. Indexing word[depth] directly would yield
// bytes, and the two disagree the moment a character is not ASCII.
// Returns true if the caller may prune the node it passed in.
func (t *Trie) Delete(word string) bool {
    return t.deleteHelper(t.root, []rune(word), 0)
}

func (t *Trie) deleteHelper(node *TrieNode, word []rune, depth int) bool {
    if node == nil {
        return false
    }

    if depth == len(word) {
        if !node.isEnd {
            return false // word was never in the trie
        }
        node.isEnd = false
        node.word = ""
        return len(node.children) == 0
    }

    ch := word[depth]
    if t.deleteHelper(node.children[ch], word, depth+1) {
        delete(node.children, ch)
        return !node.isEnd && len(node.children) == 0
    }

    return false
}
```

Two details in `Delete` are worth dwelling on, because both are easy to get wrong and neither announces itself in testing.

The first is the rune-versus-byte mismatch. `Insert` uses `for _, ch := range word`, and ranging over a string in Go yields runes, decoding UTF-8 as it goes. So the key for "é" is a single rune, 233. Had `Delete` indexed `word[depth]`, it would have gotten bytes, and "é" is two of them, 0xC3 and 0xA9. Neither matches. The original version of this code made exactly that mistake, and the failure was silent: `Delete("café")` returned false, changed nothing, and left the word in the trie. `len(word)` compounds it, since that is a byte count and the recursion is counting rune levels. Converting once with `[]rune(word)` makes both agree. The general rule: pick runes or bytes for your trie and use the same one in every operation. Mixing them produces a structure that works perfectly until someone types a non-ASCII character.

The second is the return value, which does not mean "deleted". It means "this child is now safe to prune", true only when the node no longer ends a word and has no remaining children. That is what stops `Delete("app")` from destroying "apple": the node at "app" still has a child "l", so it returns false, the parent keeps the link, and only the `isEnd` flag is cleared. Pruning a node that still has descendants would silently delete every word beneath it.

### Array-Based Trie (Faster for Lowercase Letters)

When the alphabet is small and known in advance, such as the 26 lowercase ASCII letters, replacing the map of children with a fixed-size array of 26 pointers removes the hashing from every step. Each character maps to an index by subtracting `'a'`, so a child lookup is a direct load instead of a map probe, and the children sit contiguously for the prefetcher to work with.

It is worth being blunt about what this does and does not buy, because the usual claim is that the array is the memory-efficient option and that is not true. Measure it. `unsafe.Sizeof` puts an array node at 216 bytes, since 26 pointers occupy 208 bytes whether or not any of them are used, against 16 bytes for a map node, whose map field is one pointer to a lazily allocated header. Building both tries over 50,000 random lowercase words gives roughly 51 MB for the array trie against 40 MB for the map trie. The array costs about 1.3x more.

The reason is that a trie is mostly leaves, and a leaf has no children at all. The array trie pays the full 208 bytes for a leaf's empty slots, while a map trie's leaf holds a nil map and pays nothing for the children it does not have. This holds even for dense input: build every three-letter word, so that each internal node genuinely has all 26 children, and the array trie is still several times larger, because the 17,576 leaves dominate the node count and every one of them carries a fully empty array.

What the array actually buys is speed. Benchmarked on the same 50,000 words, lookups run near 200ns against roughly 350ns for the map version, about 1.7x faster. So the honest trade is speed and simplicity against memory, and it points the opposite way from the folklore. Reach for the array when the alphabet is small, fixed, and the lookup is hot. Reach for the map when the alphabet is large or unknown, when the trie is sparse, or when memory is the binding constraint.

One precondition the code below does not enforce: `idx := ch - 'a'` assumes every character is a lowercase ASCII letter. Feed it `'A'` and the index is -32. Feed it `'é'` and the index is 136. Both are outside the array and both panic. The map-based trie has no such restriction, which is the other half of why it exists.

```go
// ArrayTrie uses fixed-size arrays for lowercase letters.
// Precondition: every character of every word is in [a-z]. Anything else
// indexes outside children and panics. Validate at the API boundary.
type ArrayTrieNode struct {
    children [26]*ArrayTrieNode
    isEnd    bool
}

type ArrayTrie struct {
    root *ArrayTrieNode
}

func NewArrayTrie() *ArrayTrie {
    return &ArrayTrie{root: &ArrayTrieNode{}}
}

func (t *ArrayTrie) Insert(word string) {
    node := t.root
    for _, ch := range word {
        idx := ch - 'a'
        if node.children[idx] == nil {
            node.children[idx] = &ArrayTrieNode{}
        }
        node = node.children[idx]
    }
    node.isEnd = true
}

func (t *ArrayTrie) Search(word string) bool {
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

func (t *ArrayTrie) StartsWith(prefix string) bool {
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

### Word Search II with Trie

Searching for multiple words simultaneously in a 2D character grid becomes efficient when all target words are pre-loaded into a trie, allowing the DFS traversal to prune entire branches the moment no inserted word shares the current path prefix. Without a trie, each word would require a separate DFS pass over the board. With one, a single pass explores all words in parallel by following trie edges alongside board cells. A result set (map) deduplicates words found via multiple paths before returning the final list.

```go
// FindWords finds all words from dictionary that exist in grid
// LeetCode 212: Word Search II
// Time: O(m*n * 4^L) where L is max word length
func FindWords(board [][]byte, words []string) []string {
    trie := NewTrie()
    for _, word := range words {
        trie.Insert(word)
    }

    m, n := len(board), len(board[0])
    result := make(map[string]bool)
    directions := [][]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}

    var dfs func(i, j int, node *TrieNode)
    dfs = func(i, j int, node *TrieNode) {
        ch := rune(board[i][j])
        if node.children[ch] == nil {
            return
        }

        nextNode := node.children[ch]
        if nextNode.isEnd {
            result[nextNode.word] = true
        }

        // Mark as visited
        board[i][j] = '#'

        for _, dir := range directions {
            ni, nj := i+dir[0], j+dir[1]
            if ni >= 0 && ni < m && nj >= 0 && nj < n && board[ni][nj] != '#' {
                dfs(ni, nj, nextNode)
            }
        }

        // Restore
        board[i][j] = byte(ch)
    }

    for i := 0; i < m; i++ {
        for j := 0; j < n; j++ {
            dfs(i, j, trie.root)
        }
    }

    words = []string{}
    for word := range result {
        words = append(words, word)
    }
    return words
}
```

### Autocomplete with Trie

An autocomplete system built on a trie stores, at every node along a sentence's path, a frequency count for each complete sentence passing through that node. When the user types a character, the system descends one level and reads the pre-aggregated counts off the current node instead of walking the subtree beneath it. Results are ordered by count descending, with alphabetical order as the tiebreaker, and the top three are returned.

Be clear-eyed about what this design trades, since it is the interesting part and an interviewer will probe it. Caching the counts at every node is a deliberate exchange of memory for latency, and the memory is not a rounding error: a sentence of length L is recorded in L separate maps, once at each node on its path, so storage is proportional to the total number of characters across the corpus rather than to the number of sentences. Nor does it remove the per-keystroke work entirely. It removes the subtree walk, but the node's counts still get sorted on every call, which is O(k log k) in the number of sentences through that node. That number is largest exactly where it hurts, at the shallow nodes near the root, where the first keystroke of a query lands. Keeping a small top-k heap per node, rather than a map plus a full sort, is the natural next step, and saying so unprompted is the difference between reciting the LeetCode solution and understanding it.

```go
import "sort"

// AutocompleteSystem implements search autocomplete
// LeetCode 642: Design Search Autocomplete System
type AutocompleteSystem struct {
    root    *ACTrieNode
    current *ACTrieNode
    prefix  string
}

type ACTrieNode struct {
    children map[rune]*ACTrieNode
    count    map[string]int
}

func Constructor(sentences []string, times []int) AutocompleteSystem {
    root := &ACTrieNode{
        children: make(map[rune]*ACTrieNode),
        count:    make(map[string]int),
    }

    ac := AutocompleteSystem{root: root, current: root}

    for i, sentence := range sentences {
        ac.addSentence(sentence, times[i])
    }

    return ac
}

func (ac *AutocompleteSystem) addSentence(sentence string, count int) {
    node := ac.root
    for _, ch := range sentence {
        if node.children[ch] == nil {
            node.children[ch] = &ACTrieNode{
                children: make(map[rune]*ACTrieNode),
                count:    make(map[string]int),
            }
        }
        node = node.children[ch]
        node.count[sentence] += count
    }
}

func (ac *AutocompleteSystem) Input(c byte) []string {
    if c == '#' {
        ac.addSentence(ac.prefix, 1)
        ac.prefix = ""
        ac.current = ac.root
        return []string{}
    }

    ac.prefix += string(c)

    if ac.current == nil {
        return []string{}
    }

    ac.current = ac.current.children[rune(c)]
    if ac.current == nil {
        return []string{}
    }

    // Get top 3 sentences
    type item struct {
        sentence string
        count    int
    }

    items := []item{}
    for s, cnt := range ac.current.count {
        items = append(items, item{s, cnt})
    }

    sort.Slice(items, func(i, j int) bool {
        if items[i].count != items[j].count {
            return items[i].count > items[j].count
        }
        return items[i].sentence < items[j].sentence
    })

    result := []string{}
    for i := 0; i < 3 && i < len(items); i++ {
        result = append(result, items[i].sentence)
    }

    return result
}
```

### Junior → FAANG: Trie Implementation Variants and When to Use Each

Three trie variants appear in interviews. The fixed-array trie (`[26]*TrieNode` children) is fastest and simplest for lowercase English only, at the cost of more memory, not less, as measured earlier in this section. The map-based trie (`map[rune]*TrieNode`) supports Unicode and sparse alphabets and is the smaller of the two, paying for it with a hash on every step. The binary trie (`[2]*TrieNode`) is used for XOR problems over integer bit representations (LC 421). Know which variant to reach for based on the problem's input domain: the interviewer will notice if you use a 26-array trie on a problem with arbitrary Unicode characters. The `isEnd` flag is non-negotiable in all three variants: its absence turns the trie into a prefix checker rather than a word checker.

### Senior @ FAANG: Trie Scalability: From Single-Node to Distributed Prefix Index

At the senior level, a single-node trie backs a local autocomplete cache, but a distributed trie is needed when the vocabulary exceeds memory or the query rate requires horizontal scaling. The standard architecture is range-partitioned sharding: sort all keys lexicographically and assign contiguous prefix ranges to shards. A coordinator receives each prefix query, determines which shard(s) own the relevant prefix range, fans out the query, and merges the top-k results. The challenge is that prefix ranges are not uniformly sized (common prefixes like "the" appear in exponentially more keys than "xyl"), so shards must be split based on key count rather than lexicographic range. This is the same problem solved by range-partitioned databases with split thresholds, and the implementation uses a shard map that is consulted by the coordinator and updated asynchronously by a background balancer. The staff-level ADR for this system documents: the shard split and merge policy, the consistency model for the shard map (strong consistency is required for correctness, achieved via a consensus service), the replication factor for each shard, and the fallback behavior when a shard is unavailable (return cached results, return partial results, or return an error).
