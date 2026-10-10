## 75.9 Classic Greedy Problems

### Huffman Coding

Huffman coding is a greedy algorithm for building an optimal prefix-free binary encoding. Characters that appear more frequently get shorter bit strings, and characters that appear less frequently get longer ones. The algorithm repeatedly extracts the two lowest-frequency nodes from a min-heap, merges them into a new internal node whose frequency is their sum, and pushes the merged node back. This process continues until only one node (the root) remains, forming a binary tree where each leaf represents a character and the path from root to leaf gives its code. Huffman coding is provably optimal among prefix-free codes and is the foundation of many compression formats.

```go
// HuffmanNode represents a node in Huffman tree
type HuffmanNode struct {
    char  byte
    freq  int
    left  *HuffmanNode
    right *HuffmanNode
}

// HuffmanHeap implements heap.Interface for Huffman nodes
type HuffmanHeap []*HuffmanNode

func (h HuffmanHeap) Len() int           { return len(h) }
func (h HuffmanHeap) Less(i, j int) bool { return h[i].freq < h[j].freq }
func (h HuffmanHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *HuffmanHeap) Push(x any) { *h = append(*h, x.(*HuffmanNode)) }
func (h *HuffmanHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

// BuildHuffmanTree creates a Huffman tree from character frequencies.
// Returns nil for an empty frequency map: with no symbols there is no tree, and
// popping an empty heap would panic.
// Time: O(k log k) for k distinct characters, Space: O(k)
func BuildHuffmanTree(freq map[byte]int) *HuffmanNode {
    if len(freq) == 0 {
        return nil
    }

    h := &HuffmanHeap{}
    heap.Init(h)

    for char, f := range freq {
        heap.Push(h, &HuffmanNode{char: char, freq: f})
    }

    for h.Len() > 1 {
        left := heap.Pop(h).(*HuffmanNode)
        right := heap.Pop(h).(*HuffmanNode)

        merged := &HuffmanNode{
            freq:  left.freq + right.freq,
            left:  left,
            right: right,
        }
        heap.Push(h, merged)
    }

    return heap.Pop(h).(*HuffmanNode)
}

// GetHuffmanCodes generates codes from tree
func GetHuffmanCodes(root *HuffmanNode) map[byte]string {
    codes := make(map[byte]string)
    generateCodes(root, "", codes)
    return codes
}

func generateCodes(node *HuffmanNode, code string, codes map[byte]string) {
    if node == nil {
        return
    }

    if node.left == nil && node.right == nil {
        if code == "" {
            code = "0" // Single character case
        }
        codes[node.char] = code
        return
    }

    generateCodes(node.left, code+"0", codes)
    generateCodes(node.right, code+"1", codes)
}
```

### Fractional Knapsack

The fractional knapsack problem allows you to take fractions of items, unlike the 0/1 knapsack where you must take an item entirely or not at all. Because you can break items apart, the greedy strategy of always taking the item with the highest value-to-weight ratio is provably optimal. You sort items by this ratio in descending order, then greedily fill the knapsack. If the current item fits entirely, take all of it. Otherwise, take as much as the remaining capacity allows and stop. This runs in O(n log n) due to the sort.

```go
// Item represents an item for knapsack
type Item struct {
    weight float64
    value  float64
}

// FractionalKnapsack solves the fractional knapsack problem: items may be split,
// so the highest value-per-weight ratio first is provably optimal.
//
// Contrast with 0/1 knapsack, where items cannot be split and this same greedy
// is simply wrong. See Section 75.8's counterexample discussion.
// Sorts items in place. Time: O(n log n), Space: O(log n) for the sort's stack.
func FractionalKnapsack(items []Item, capacity float64) float64 {
    // Sort by value/weight ratio, descending. Compare a.value*b.weight against
    // b.value*a.weight rather than dividing: a zero-weight item would otherwise
    // produce Inf or NaN, and a NaN comparator makes the sort order meaningless.
    slices.SortFunc(items, func(a, b Item) int {
        return cmp.Compare(b.value*a.weight, a.value*b.weight)
    })

    totalValue := 0.0

    for _, item := range items {
        if capacity >= item.weight {
            totalValue += item.value
            capacity -= item.weight
        } else {
            // Take fraction of item
            totalValue += (capacity / item.weight) * item.value
            break
        }
    }

    return totalValue
}
```

### Junior → FAANG: Huffman and Fractional Knapsack as Proof Vehicles

Huffman coding and fractional knapsack are the two classic problems used to teach greedy correctness proofs, and they appear in system design interviews as well as coding rounds. For Huffman, the key insight is that combining the two least-frequent nodes is always safe. State the lemma carefully, because the sloppy version is a common interview stumble: it is not that *every* optimal code makes the two rarest symbols siblings, it is that *there exists* an optimal code in which they are siblings at maximum depth. The proof is an exchange argument. Take any optimal tree, find the two deepest siblings, and swap them with the two lowest-frequency symbols. Swapping a lower-frequency symbol to a deeper position can never increase the weighted path length, so the result is still optimal and has the property you wanted. Greedy's first merge is therefore safe, and induction on the reduced alphabet finishes the argument.

For interview preparation, understand the priority queue implementation deeply. The Go `heap` package requires implementing `heap.Interface`, and writing a correct min-heap for Huffman nodes from memory is a useful exercise. A common mistake is using a max-heap (reversing the Less function) which produces a max-frequency-first merge and generates the wrong tree.

For fractional knapsack, the proof is simpler: if you take less than the full amount of the highest-ratio item, you can always swap some of a lower-ratio item for more of the highest-ratio item and improve the solution. This is the exchange argument in its purest form. Practice stating it in under 30 seconds.

### Senior @ FAANG: Huffman Coding in Real Compression Systems and Protocol Design

Huffman coding is not just an academic exercise. It is the foundation of DEFLATE (used in zlib, gzip, and ZIP), HPACK (HTTP/2 header compression), and many other production compression formats. Understanding its properties and limitations is a staff-level knowledge point.

**Static vs. adaptive Huffman.** The standard Huffman algorithm requires a full pass over the data to compute frequencies before building the tree. Adaptive Huffman coding (Vitter's algorithm) builds the tree online, updating it as each symbol is encoded. Adaptive Huffman is used when the data stream cannot be buffered (real-time audio and video encoding). The trade-off: adaptive Huffman has higher computational overhead per symbol but zero latency for the first symbol. Static Huffman has lower per-symbol overhead but requires a two-pass encoding. Staff engineers choose between them based on latency requirements, not just compression ratio.

**HPACK and header compression in HTTP/2.** HTTP/2's HPACK (RFC 7541) uses a fixed Huffman table, computed once from a corpus of representative HTTP headers and baked into the specification, alongside a static table of common header pairs and a per-connection dynamic table. Because the Huffman code is part of the spec rather than negotiated, no synchronization is needed. The dynamic table evicts from the oldest end when a new entry would exceed the size limit, which is FIFO by insertion order and not LRU: a frequently referenced entry gets no reprieve from being referenced. This is a production example of a greedy algorithm (Huffman) serving as a component where full adaptive coding would be impractical, since adapting the code per connection would cost synchronization on every update.

**Fractional knapsack in budget allocation.** The fractional knapsack problem is a model for continuous budget allocation across projects. A capital allocation system that assigns budget to projects based on expected ROI (value-to-weight ratio, where weight is budget and value is expected return) is using fractional knapsack. The greedy optimality guarantee holds as long as returns are linear (doubling investment doubles return). When returns are concave (diminishing returns), the greedy strategy overweights high-ratio projects and the correct approach is convex optimization. Staff engineers building budget allocation systems must decide which model is appropriate for their domain and document the assumption in the system design document.
