## Merkle Trees and Sparse Trees

A Merkle tree commits to a set of items with a single hash, lets a verifier check membership with a logarithmic-size proof, and lets clients sync the set incrementally. Every blockchain uses Merkle trees somewhere. Bitcoin uses a binary Merkle tree per block. Ethereum uses a Merkle Patricia Trie for state. zk-rollups use Sparse Merkle Trees, and the Ethereum roadmap moves toward Verkle Trees for stateless clients.

This section covers the three structures and gives cache-friendly C++ implementations.

### Binary Merkle Tree (Bitcoin)

A Bitcoin block's `merkleroot` is the root of a binary tree where the leaves are double-SHA256 transaction IDs. The tree is built bottom-up. If the number of leaves is odd at any level, the last leaf is duplicated. This duplication causes the famous CVE-2012-2459 malleability bug, where two different transaction lists can produce the same merkle root.

```cpp
#include <array>
#include <vector>
#include <span>
#include <cstring>

using Hash256 = std::array<std::uint8_t, 32>;

Hash256 hash256_pair(const Hash256& a, const Hash256& b) {
    std::array<std::uint8_t, 64> buf;
    std::memcpy(buf.data(), a.data(), 32);
    std::memcpy(buf.data() + 32, b.data(), 32);
    return crypto::hash256({buf.data(), buf.size()});
}

Hash256 bitcoin_merkle_root(std::vector<Hash256> txids) {
    if (txids.empty()) return {};
    while (txids.size() > 1) {
        if (txids.size() & 1) txids.push_back(txids.back());  // CVE-2012-2459 source
        std::vector<Hash256> next;
        next.reserve(txids.size() / 2);
        for (std::size_t i = 0; i < txids.size(); i += 2) {
            next.push_back(hash256_pair(txids[i], txids[i + 1]));
        }
        txids = std::move(next);
    }
    return txids[0];
}
```

CVE-2012-2459 was fixed by adding a network rule that rejects blocks where any internal level has duplicated leaves. The merkle algorithm itself is unchanged for backwards compatibility.

#### Inclusion Proof

To prove a transaction is in a block, you provide the path of sibling hashes from the leaf to the root.

```cpp
struct MerkleProof {
    std::vector<Hash256> siblings;
    std::uint32_t index;  // bitfield of left/right at each level
};

bool verify_inclusion(const Hash256& leaf, const MerkleProof& proof, const Hash256& root) {
    Hash256 cur = leaf;
    std::uint32_t idx = proof.index;
    for (const auto& sib : proof.siblings) {
        cur = (idx & 1) ? hash256_pair(sib, cur) : hash256_pair(cur, sib);
        idx >>= 1;
    }
    return cur == root;
}
```

The proof size is `log2(N)` hashes, so 32 hashes for a block with up to 4 billion transactions, which is roughly 1KB. SPV (simplified payment verification) wallets like the original Electrum used this to verify transactions without downloading full blocks.

#### Cache-Friendly Layout

When you build merkle trees at scale (a Bitcoin node validating thousands of blocks per minute during IBD), the naive `vector<Hash256>` per level allocates and frees too aggressively. The cache-friendly approach is a single contiguous buffer of `2N - 1` hashes laid out level by level.

```cpp
class MerkleTree {
public:
    explicit MerkleTree(std::vector<Hash256> leaves) {
        std::size_t n = leaves.size();
        std::size_t total = 0;
        for (std::size_t lvl = n; lvl > 1; lvl = (lvl + 1) / 2) total += lvl;
        total += 1;  // root
        nodes_.reserve(total + n);
        nodes_ = std::move(leaves);

        std::size_t level_start = 0;
        std::size_t level_size = n;
        while (level_size > 1) {
            std::size_t next_start = nodes_.size();
            for (std::size_t i = 0; i < level_size; i += 2) {
                std::size_t r = std::min(i + 1, level_size - 1);
                nodes_.push_back(hash256_pair(
                    nodes_[level_start + i], nodes_[level_start + r]));
            }
            level_start = next_start;
            level_size = (level_size + 1) / 2;
        }
        root_ = nodes_.back();
    }

    [[nodiscard]] const Hash256& root() const noexcept { return root_; }

private:
    std::vector<Hash256> nodes_;
    Hash256 root_;
};
```

This single buffer fits in 64 bytes per node and allows the prefetcher to stream level N to level N+1 without TLB misses. On a Bitcoin block of 3000 transactions, this is 30 percent faster than the naive version on a Skylake-era CPU.

### Merkle Patricia Trie (Ethereum)

Ethereum's state is a 256-bit-keyed key-value store. Every account address (or storage slot) maps to a value, and the entire state commits to a single root hash. The data structure is the Merkle Patricia Trie (MPT), a hex-radix trie with hash pointers.

The MPT has four node types:

- **Branch**: 17 children (16 for each hex nibble plus one optional value).
- **Extension**: a shared prefix and one child.
- **Leaf**: a remaining key suffix and a value.
- **Empty**.

Each node is RLP-encoded, then keccak-256 hashed. Children are referenced by hash. The root is the keccak-256 of the RLP encoding of the top node.

The MPT has well-known performance problems:

- **Hash recomputation cost**. Updating a single account requires re-hashing all nodes on the path, which is up to 64 nibbles deep.
- **Storage amplification**. Every node is a separate entry in LevelDB, so a single account update creates dozens of LevelDB writes.
- **No proof aggregation**. Witnesses for multiple keys do not share much.

This is why Ethereum is moving to Verkle Trees.

### Sparse Merkle Tree (zk-rollups)

A Sparse Merkle Tree (SMT) is a binary Merkle tree of fixed depth (typically 256), where every possible key has a leaf and unset leaves have a default value (zero). The trick that makes this efficient is **subtree compression**: a subtree of all-zero leaves has a deterministic hash that can be precomputed.

```cpp
class SparseMerkleTree {
public:
    static constexpr std::size_t depth = 256;

    SparseMerkleTree() {
        // Precompute zero subtree hashes
        zero_hashes_[0] = {};  // hash of empty leaf
        for (std::size_t i = 1; i <= depth; ++i) {
            zero_hashes_[i] = hash_pair(zero_hashes_[i - 1], zero_hashes_[i - 1]);
        }
    }

    void insert(std::span<const std::uint8_t, 32> key, const Hash256& value) {
        // Walk from leaf to root, updating only the touched path
        std::array<Hash256, depth + 1> path;
        path[depth] = value;
        Hash256 cur = value;
        for (std::size_t i = depth; i > 0; --i) {
            bool right = bit(key, i - 1);
            Hash256 sibling = get_sibling(key, i - 1);
            cur = right ? hash_pair(sibling, cur) : hash_pair(cur, sibling);
            store_sibling(key, i - 1, cur);
        }
        root_ = cur;
    }

    [[nodiscard]] Hash256 root() const noexcept { return root_; }

private:
    static bool bit(std::span<const std::uint8_t, 32> key, std::size_t i);
    Hash256 get_sibling(std::span<const std::uint8_t, 32> key, std::size_t level);
    void store_sibling(std::span<const std::uint8_t, 32> key, std::size_t level, const Hash256& h);

    std::array<Hash256, depth + 1> zero_hashes_;
    std::unordered_map<std::string, Hash256> nodes_;  // production: use rocksdb
    Hash256 root_;
};
```

zkSync, Scroll, and Polygon zkEVM all use SMTs. The reason is that the proving circuit is simpler: a fixed-depth tree has a fixed-cost circuit, whereas an MPT's variable depth makes the circuit much larger.

### Verkle Trees

Verkle trees replace hash-based commitments with vector commitments based on inner product arguments (IPA) over an elliptic curve. The tradeoff:

- **Branching factor 256** instead of 16, so the tree depth drops from 64 to 32 levels.
- **Witness size 200 bytes** for any key, regardless of state size, versus several KB for an MPT proof.
- **Proof cost is one IPA opening** instead of `depth` hashes.
- **Computation cost is higher**. Each commit is roughly 100 microseconds on a single core versus 1 microsecond for keccak-256.

Ethereum's Verkle transition is part of the Pectra-and-beyond roadmap. The reference C++ implementation lives in the `go-verkle` repo's C bindings, and EF research has prototype implementations in C++ for embedded clients.

### Senior Track Notes

- **Bitcoin's merkle tree is wasteful**. SHA-256 of two 32-byte inputs is the same cost as SHA-256 of a 64-byte input. A modern design (BLAKE3 tree mode) parallelizes across cores trivially. Bitcoin keeps SHA-256 because of the consensus weight.
- **Ethereum's MPT performance bottleneck is LevelDB random reads**. A single block validation does 30,000 random reads on the trie database, which is why Erigon and Reth use a flat-state layout with a separate trie commitment computed lazily.
- **SMT proof compression**. A real SMT proof omits the zero-subtree siblings and replaces them with a bitfield, reducing proof size from 32 KB to 1 to 2 KB for typical keys.
- **Verkle witness aggregation** is non-trivial. Multiple keys in the same block can share an opening, but the IPA combination is itself a 1ms operation. The Ethereum stateless-client design assumes the block builder pre-computes the aggregate witness.

The next section steps up from primitives to a complete blockchain core: Bitcoin Core's architecture.

---
