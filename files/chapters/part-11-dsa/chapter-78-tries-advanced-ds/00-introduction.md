# Chapter 78: Tries and Advanced Data Structures

> *"The right data structure is worth a thousand algorithms."*
> - Robert Sedgewick

Every experienced engineer has had the moment where choosing the right data structure collapses a complex algorithm into a trivial one. Tries (prefix trees) are the clearest example, though it pays to be precise about where the win actually is. For looking up one whole word, a trie is O(L) in the length of the word, and a hash map is also O(L), since it must hash those same L bytes. The trie does not win there. It wins on prefixes. Asking "which of my words start with `pre`?" forces a hash map to examine every key it holds, O(n * L) for n words of average length L, because hashing destroys the ordering that would let it do better. A trie walks the L characters of the prefix and reads the answers out of the subtree beneath, O(L + k) for k matches, no matter how large the vocabulary. Any structure can find a word. The trie is what makes the *prefix* the query.

The trie is only the beginning. This chapter covers the structures that sit at the frontier of interview difficulty and production engineering: tries for prefix queries, segment trees for range queries with updates, Fenwick trees (Binary Indexed Trees) for prefix sums, and LRU and LFU caches that combine a hash map with a linked list into a single purpose-built tool.

Go's struct types and pointer semantics make these natural to implement. A trie node is a struct with a `[26]*TrieNode` children array and an `isEnd bool` flag, or a `map[rune]*TrieNode` when the alphabet is not 26 lowercase letters. Section 78.1 works through what that choice costs, because it is the first real memory decision in the chapter and the intuitive answer is not the whole story. Segment trees map onto Go slices with the classic `2*i` and `2*i+1` child indexing, and Fenwick trees lean on integer bit operations for their `i += i & (-i)` traversal. Each of these rewards implementing from scratch, and interviewers ask you to implement, not import.

The chapter is organized around problem patterns rather than structures in isolation. You will learn when a trie beats a hash map (prefix queries, autocomplete, Word Search II), when a Fenwick tree beats a plain array (dynamic prefix sums under point updates), when a segment tree is the right answer (range minimum or maximum, range updates with lazy propagation), and how the LRU and LFU caches get O(1) operations by pairing two structures that each cover the other's weakness. Every structure is implemented in idiomatic Go with its complexity analysed and anchored to the interview problems it solves.

**What you'll learn in this chapter:**

- Building a Trie from scratch in Go with insert, search, startsWith, and delete operations. Handling Unicode with `map[rune]*TrieNode`
- Weighing the `[26]*TrieNode` array against the `map[rune]*TrieNode` alternative, and measuring rather than guessing which costs more memory
- Solving Word Search II using Trie plus DFS with pruning, and understanding why searching all words at once beats searching them one at a time
- Building a Fenwick Tree (BIT) for O(log n) prefix sum queries and point updates
- Constructing a Segment Tree for O(log n) range queries (sum, min, max) with optional lazy propagation for range updates
- Implementing LRU Cache and LFU Cache using doubly linked list plus hash map combinations in Go
- Recognizing which structure to reach for given a problem's query pattern, update frequency, and data type

**Why this matters in interviews:**

Advanced data structure problems sit in the "hard" tier of onsites and are strong positive signals for senior and staff-level candidates. Trie problems (Word Search II, Replace Words, Implement Magic Dictionary) and range query problems (segment tree, BIT) are common at the senior bar. LRU and LFU cache design shows up constantly, particularly for infrastructure and production engineering roles, because it bridges pure DSA and system design in a single question. Tries anchor autocomplete system design questions. What distinguishes a strong answer is not reciting the interface but knowing the internal mechanics, the real complexity, and the failure modes. This chapter is the final piece of the DSA foundation before the interview mastery section.

**Prerequisites:** Chapter 70 (Trees and Binary Search Trees), Chapter 72 (Graphs), Chapter 76 (Bit Manipulation), whose index arithmetic the Fenwick tree depends on, and solid Go struct and pointer mechanics.

---

### Junior → FAANG: Why This Chapter Changes Your Interview Ceiling

Most candidates plateau at "medium" difficulty because they lack fluency with the structures covered here. Tries, Fenwick trees, and segment trees separate candidates who solve mediums reliably from candidates who solve hards with confidence. The entry-level goal is not mastery of every variant but a working implementation of each core structure and recognition of the problem shapes it solves. After finishing this chapter, solve LC 208 (Implement Trie), LC 307 (Range Sum Query Mutable), and LC 146 (LRU Cache) from scratch without references. Those three map directly onto Sections 78.1, 78.3, and 78.4, and getting them right validates that your trie, Fenwick tree, and LRU implementations are interview-ready.

### Senior @ FAANG: This Chapter as a Prerequisite for Platform Engineering Conversations

At the senior level, the structures in this chapter are prerequisites for participating in platform engineering discussions. Autocomplete system design (trie at the core), time-series aggregation (Fenwick or segment tree at the core), and cache eviction policy (LRU or LFU at the core) all require fluency with these structures. A staff engineer who cannot implement and reason about a trie cannot credibly own the autocomplete infrastructure. A staff engineer who cannot explain the Fenwick tree's update and query operations cannot review the correctness of a streaming aggregation pipeline. This chapter is the algorithmic foundation for a specific class of platform ownership at FAANG, and the depth expected at L6/L7 goes beyond correct implementation to include: production failure modes, concurrency correctness, operational observability, and migration paths to more scalable alternatives.
