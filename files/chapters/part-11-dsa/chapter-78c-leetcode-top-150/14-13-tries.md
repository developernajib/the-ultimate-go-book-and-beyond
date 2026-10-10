## 78C.13 Tries

A trie (prefix tree) stores strings character by character, enabling efficient prefix searches and autocomplete.

---
### LC 208 - Implement Trie (Prefix Tree) 🟡

**Key Insight**: Each node has up to 26 children. Mark end-of-word nodes.

```go
type Trie struct {
    children [26]*Trie
    isEnd    bool
}

func Constructor() Trie {
    return Trie{}
}

func (t *Trie) Insert(word string) {
    node := t
    for i := 0; i < len(word); i++ {
        idx := word[i] - 'a'
        if node.children[idx] == nil {
            node.children[idx] = &Trie{}
        }
        node = node.children[idx]
    }
    node.isEnd = true
}

func (t *Trie) Search(word string) bool {
    node := t.find(word)
    return node != nil && node.isEnd
}

func (t *Trie) StartsWith(prefix string) bool {
    return t.find(prefix) != nil
}

func (t *Trie) find(s string) *Trie {
    node := t
    for i := 0; i < len(s); i++ {
        idx := s[i] - 'a'
        if node.children[idx] == nil {
            return nil
        }
        node = node.children[idx]
    }
    return node
}
```
**Time**: O(L) per operation where L = word length.
**Space**: O(total characters inserted).

---
### LC 211 - Design Add and Search Words Data Structure 🟡

**Key Insight**: Same as a trie, but search supports the `.` wildcard by branching to all children.

```go
type WordDictionary struct {
    children [26]*WordDictionary
    isEnd    bool
}

func Constructor() WordDictionary {
    return WordDictionary{}
}

func (wd *WordDictionary) AddWord(word string) {
    node := wd
    for i := 0; i < len(word); i++ {
        idx := word[i] - 'a'
        if node.children[idx] == nil {
            node.children[idx] = &WordDictionary{}
        }
        node = node.children[idx]
    }
    node.isEnd = true
}

func (wd *WordDictionary) Search(word string) bool {
    return wd.searchFrom(word, 0)
}

func (wd *WordDictionary) searchFrom(word string, start int) bool {
    node := wd
    for i := start; i < len(word); i++ {
        if word[i] == '.' {
            for _, child := range node.children {
                if child != nil && child.searchFrom(word, i+1) {
                    return true
                }
            }
            return false
        }
        idx := word[i] - 'a'
        if node.children[idx] == nil {
            return false
        }
        node = node.children[idx]
    }
    return node.isEnd
}
```
**Time**: O(L) for add, O(26^dots × L) worst case for search with dots.
**Space**: O(total characters).

---
### LC 212 - Word Search II 🔴

**Key Insight**: Build a trie from the word list, then DFS on the board using the trie to prune branches. This is much faster than searching each word separately.

```go
type TrieNode struct {
    children [26]*TrieNode
    word     string
}

func findWords(board [][]byte, words []string) []string {
    root := &TrieNode{}
    for _, w := range words {
        node := root
        for i := 0; i < len(w); i++ {
            idx := w[i] - 'a'
            if node.children[idx] == nil {
                node.children[idx] = &TrieNode{}
            }
            node = node.children[idx]
        }
        node.word = w
    }

    rows, cols := len(board), len(board[0])
    var result []string

    var dfs func(r, c int, node *TrieNode)
    dfs = func(r, c int, node *TrieNode) {
        if r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] == '#' {
            return
        }
        ch := board[r][c]
        next := node.children[ch-'a']
        if next == nil {
            return
        }
        if next.word != "" {
            result = append(result, next.word)
            next.word = "" // avoid duplicates
        }

        board[r][c] = '#'
        dfs(r+1, c, next)
        dfs(r-1, c, next)
        dfs(r, c+1, next)
        dfs(r, c-1, next)
        board[r][c] = ch
    }

    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            dfs(r, c, root)
        }
    }
    return result
}
```
**Time**: O(m × n × 4^L) with trie pruning.
**Space**: O(total word characters).

---
### LC 421 - Maximum XOR of Two Numbers in an Array 🟡

**Key Insight**: Insert all numbers into a binary trie (bit by bit from MSB). For each number, greedily choose the opposite bit to maximize XOR.

```go
type BitTrie struct {
    children [2]*BitTrie
}

func findMaximumXOR(nums []int) int {
    root := &BitTrie{}

    insert := func(num int) {
        node := root
        for i := 31; i >= 0; i-- {
            bit := (num >> i) & 1
            if node.children[bit] == nil {
                node.children[bit] = &BitTrie{}
            }
            node = node.children[bit]
        }
    }

    query := func(num int) int {
        node := root
        xorVal := 0
        for i := 31; i >= 0; i-- {
            bit := (num >> i) & 1
            want := 1 - bit
            if node.children[want] != nil {
                xorVal |= 1 << i
                node = node.children[want]
            } else {
                node = node.children[bit]
            }
        }
        return xorVal
    }

    for _, n := range nums {
        insert(n)
    }

    maxXOR := 0
    for _, n := range nums {
        x := query(n)
        if x > maxXOR {
            maxXOR = x
        }
    }
    return maxXOR
}
```
**Time**: O(32 × n) = O(n).
**Space**: O(32 × n).

---
### LC 648 - Replace Words 🟡

**Key Insight**: Build a trie from the dictionary. For each word in the sentence, find the shortest prefix in the trie.

```go
type TrieNode struct {
    children [26]*TrieNode
    word     string
}

func replaceWords(dictionary []string, sentence string) string {
    root := &TrieNode{}
    for _, d := range dictionary {
        node := root
        for i := 0; i < len(d); i++ {
            idx := d[i] - 'a'
            if node.children[idx] == nil {
                node.children[idx] = &TrieNode{}
            }
            node = node.children[idx]
        }
        node.word = d
    }

    words := strings.Split(sentence, " ")
    for i, w := range words {
        node := root
        for j := 0; j < len(w); j++ {
            idx := w[j] - 'a'
            if node.children[idx] == nil {
                break
            }
            node = node.children[idx]
            if node.word != "" {
                words[i] = node.word
                break
            }
        }
    }
    return strings.Join(words, " ")
}
```
**Time**: O(d × L + s × L) where d = dict size, s = sentence words, L = avg length.
**Space**: O(total dictionary characters).

---

### Junior → FAANG: Building a Trie from Scratch in Interviews

The trie implementation skill is tested in two forms: as an explicit "implement a trie" problem (LC 208), and as an optimization tool embedded in a harder problem (LC 212 Word Search II, LC 421 Maximum XOR). In the first form, the pitfall is forgetting the `isEnd` flag, which causes `Search` to return true for any prefix. In the second form, the insight that a trie enables pruning (Word Search II stops DFS branches that do not match any dictionary prefix) must be stated aloud before coding. For the XOR trie, the key insight is processing bits from MSB to LSB and greedily choosing the opposite bit. Practice implementing all three variants until the structural patterns are automatic.

### Senior @ FAANG: Trie Variants in Production: Radix Trees, Compressed Tries, and Prefix Routing

At the senior level, the interview-style fixed-alphabet trie is only the entry point. Production systems use compressed tries (radix trees) that store string edges rather than single characters, reducing node count dramatically for sparse tries. Go's `net/http` router and many HTTP frameworks use a radix tree for route matching. IP routing tables use Patricia tries (a binary radix tree) for longest-prefix matching. Autocomplete systems at Google and Amazon scale the trie across machines using a sharded architecture where each shard owns a prefix range, with a coordinator that fans out prefix queries and merges results. The staff-level design question is: "Given 10 billion stored strings and 100 million prefix queries per second, what is your trie architecture?" The answer involves: choosing between hash-map-children (Unicode support, lower constant) versus fixed-array-children (cache-line efficiency), adding a frequency field and top-k heap at each node to avoid full subtree traversal for autocomplete, using a read-write lock or lock-free trie (via epoch-based reclamation) for concurrent access, and snapshotting the trie to disk using a compact serialization format for recovery. The ADR for such a system must document the expected character distribution, the target p99 query latency, and the replication strategy for high availability.
