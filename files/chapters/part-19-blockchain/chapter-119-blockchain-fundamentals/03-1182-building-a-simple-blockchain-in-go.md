## 119.2 Building a Simple Blockchain in Go

Let's build a production-quality blockchain from scratch. We'll start simple and add complexity incrementally.

### 2.1 Block Structure

Each `Block` stores a `PrevBlockHash` field that chains it to its predecessor. Altering any historical block invalidates every subsequent hash, making tampering detectable without trusting any single authority. The `Hash` field is computed over the timestamp, transaction set, previous hash, and nonce together, so every component of the block is covered by the integrity proof.

```go
// block.go
package blockchain

import (
	"bytes"
	"encoding/gob"
	"encoding/hex"
	"fmt"
	"time"
)

// Block represents a single block in the blockchain
type Block struct {
	Timestamp     int64          // Unix timestamp when block was created
	Transactions  []*Transaction // Block payload (transactions)
	PrevBlockHash []byte         // Hash of previous block
	Hash          []byte         // Current block hash
	Nonce         int            // Proof of work nonce
	Height        int            // Block height (position in chain)
}

// NewBlock creates a new block with transactions
func NewBlock(transactions []*Transaction, prevBlockHash []byte, height int) *Block {
	block := &Block{
		Timestamp:     time.Now().Unix(),
		Transactions:  transactions,
		PrevBlockHash: prevBlockHash,
		Hash:          []byte{},
		Nonce:         0,
		Height:        height,
	}

	// Calculate merkle root for transactions
	block.Hash = block.HashTransactions()

	return block
}

// NewGenesisBlock creates the first block in the chain
func NewGenesisBlock(coinbase *Transaction) *Block {
	return NewBlock([]*Transaction{coinbase}, []byte{}, 0)
}

// HashTransactions creates a merkle root of block transactions
func (b *Block) HashTransactions() []byte {
	var transactions [][]byte

	for _, tx := range b.Transactions {
		transactions = append(transactions, tx.Serialize())
	}

	tree := NewMerkleTree(transactions)

	return tree.RootNode.Data
}

// Serialize encodes the block to bytes
func (b *Block) Serialize() ([]byte, error) {
	var result bytes.Buffer
	encoder := gob.NewEncoder(&result)

	err := encoder.Encode(b)
	if err != nil {
		return nil, fmt.Errorf("serialize block: %w", err)
	}

	return result.Bytes(), nil
}

// DeserializeBlock decodes bytes to a block
func DeserializeBlock(data []byte) (*Block, error) {
	var block Block
	decoder := gob.NewDecoder(bytes.NewReader(data))

	err := decoder.Decode(&block)
	if err != nil {
		return nil, fmt.Errorf("deserialize block: %w", err)
	}

	return &block, nil
}

// String returns a human-readable block representation
func (b *Block) String() string {
	return fmt.Sprintf(
		"Block #%d [%s]\n"+
			"  PrevHash: %s\n"+
			"  Time:     %s\n"+
			"  Nonce:    %d\n"+
			"  Txs:      %d\n",
		b.Height,
		hex.EncodeToString(b.Hash[:8]),
		hex.EncodeToString(b.PrevBlockHash[:8]),
		time.Unix(b.Timestamp, 0).Format(time.RFC3339),
		b.Nonce,
		len(b.Transactions),
	)
}
```

### 2.2 Blockchain Structure

`Blockchain` holds a `sync.RWMutex` so concurrent reads during block validation do not block each other while exclusive writes serialize block additions. The `BlockchainDB` interface abstracts persistence so the same chain logic works against an in-memory store for tests or a BoltDB on disk in production without changing the blockchain package.

```go
// blockchain.go
package blockchain

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"log"
	"sync"
)

// Blockchain represents the entire chain
type Blockchain struct {
	mu     sync.RWMutex
	blocks []*Block
	db     BlockchainDB // Persistence layer (we'll implement this)
}

// BlockchainDB defines persistence interface
type BlockchainDB interface {
	SaveBlock(block *Block) error
	GetBlock(hash []byte) (*Block, error)
	GetBlockByHeight(height int) (*Block, error)
	GetLastBlock() (*Block, error)
	GetHeight() int
}

// NewBlockchain creates a new blockchain with genesis block
func NewBlockchain(db BlockchainDB, genesisAddress string) (*Blockchain, error) {
	bc := &Blockchain{
		blocks: make([]*Block, 0),
		db:     db,
	}

	// Check if blockchain exists
	lastBlock, err := db.GetLastBlock()
	if err == nil && lastBlock != nil {
		// Load existing blockchain
		bc.blocks = append(bc.blocks, lastBlock)
		return bc, nil
	}

	// Create genesis block
	coinbaseTx := NewCoinbaseTX(genesisAddress, "Genesis Block")
	genesis := NewGenesisBlock(coinbaseTx)

	if err := db.SaveBlock(genesis); err != nil {
		return nil, fmt.Errorf("save genesis block: %w", err)
	}

	bc.blocks = append(bc.blocks, genesis)

	log.Printf("Genesis block created: %s", hex.EncodeToString(genesis.Hash))

	return bc, nil
}

// AddBlock adds a new block to the blockchain
func (bc *Blockchain) AddBlock(transactions []*Transaction) error {
	bc.mu.Lock()
	defer bc.mu.Unlock()

	// Validate all transactions
	for _, tx := range transactions {
		if !bc.VerifyTransaction(tx) {
			return fmt.Errorf("invalid transaction: %x", tx.ID)
		}
	}

	lastBlock := bc.GetLastBlock()
	newBlock := NewBlock(transactions, lastBlock.Hash, lastBlock.Height+1)

	// Mine the block (Proof of Work)
	pow := NewProofOfWork(newBlock)
	nonce, hash := pow.Run()

	newBlock.Hash = hash
	newBlock.Nonce = nonce

	// Save to database
	if err := bc.db.SaveBlock(newBlock); err != nil {
		return fmt.Errorf("save block: %w", err)
	}

	bc.blocks = append(bc.blocks, newBlock)

	log.Printf("Block mined: %s (nonce: %d)", hex.EncodeToString(hash[:8]), nonce)

	return nil
}

// GetLastBlock returns the most recent block
func (bc *Blockchain) GetLastBlock() *Block {
	bc.mu.RLock()
	defer bc.mu.RUnlock()

	if len(bc.blocks) == 0 {
		return nil
	}

	return bc.blocks[len(bc.blocks)-1]
}

// GetBlockByHeight retrieves a block at specific height
func (bc *Blockchain) GetBlockByHeight(height int) (*Block, error) {
	bc.mu.RLock()
	defer bc.mu.RUnlock()

	return bc.db.GetBlockByHeight(height)
}

// ValidateChain validates the entire blockchain
func (bc *Blockchain) ValidateChain() bool {
	bc.mu.RLock()
	defer bc.mu.RUnlock()

	for i := 1; i < len(bc.blocks); i++ {
		currentBlock := bc.blocks[i]
		prevBlock := bc.blocks[i-1]

		// Verify hash linkage
		if !bytes.Equal(currentBlock.PrevBlockHash, prevBlock.Hash) {
			log.Printf("Invalid chain: block %d prev hash mismatch", i)
			return false
		}

		// Verify proof of work
		pow := NewProofOfWork(currentBlock)
		if !pow.Validate() {
			log.Printf("Invalid chain: block %d PoW invalid", i)
			return false
		}
	}

	return true
}

// Iterator returns a blockchain iterator
func (bc *Blockchain) Iterator() *BlockchainIterator {
	return &BlockchainIterator{
		currentHash: bc.GetLastBlock().Hash,
		db:          bc.db,
	}
}

// BlockchainIterator iterates through blocks
type BlockchainIterator struct {
	currentHash []byte
	db          BlockchainDB
}

// Next returns the next block in reverse order
func (i *BlockchainIterator) Next() *Block {
	if len(i.currentHash) == 0 {
		return nil
	}

	block, err := i.db.GetBlock(i.currentHash)
	if err != nil {
		return nil
	}

	i.currentHash = block.PrevBlockHash

	return block
}

// HasNext checks if there are more blocks
func (i *BlockchainIterator) HasNext() bool {
	return len(i.currentHash) > 0
}
```

### 2.3 Merkle Tree Implementation

The Merkle tree hashes pairs of transaction IDs up a binary tree so the root hash summarizes the entire transaction set in a single 32-byte value. A single changed or reordered transaction produces a completely different Merkle root, allowing lightweight clients to verify transaction inclusion without downloading the full block body.

```go
// merkle.go
package blockchain

import (
	"crypto/sha256"
)

// MerkleTree represents a Merkle tree
type MerkleTree struct {
	RootNode *MerkleNode
}

// MerkleNode represents a node in the Merkle tree
type MerkleNode struct {
	Left  *MerkleNode
	Right *MerkleNode
	Data  []byte
}

// NewMerkleTree creates a new Merkle tree from data
func NewMerkleTree(data [][]byte) *MerkleTree {
	var nodes []*MerkleNode

	// Handle odd number of transactions by duplicating last one
	if len(data)%2 != 0 {
		data = append(data, data[len(data)-1])
	}

	// Create leaf nodes
	for _, datum := range data {
		node := NewMerkleNode(nil, nil, datum)
		nodes = append(nodes, node)
	}

	// Build tree bottom-up
	for len(nodes) > 1 {
		// If odd number of nodes, duplicate the last one
		if len(nodes)%2 != 0 {
			nodes = append(nodes, nodes[len(nodes)-1])
		}

		var level []*MerkleNode

		for i := 0; i < len(nodes); i += 2 {
			node := NewMerkleNode(nodes[i], nodes[i+1], nil)
			level = append(level, node)
		}

		nodes = level
	}

	tree := MerkleTree{RootNode: nodes[0]}

	return &tree
}

// NewMerkleNode creates a new Merkle node
func NewMerkleNode(left, right *MerkleNode, data []byte) *MerkleNode {
	node := MerkleNode{}

	if left == nil && right == nil {
		// Leaf node
		hash := sha256.Sum256(data)
		node.Data = hash[:]
	} else {
		// Internal node: concatenate child hashes
		prevHashes := make([]byte, len(left.Data)+len(right.Data))
		copy(prevHashes, left.Data)
		copy(prevHashes[len(left.Data):], right.Data)
		hash := sha256.Sum256(prevHashes)
		node.Data = hash[:]
	}

	node.Left = left
	node.Right = right

	return &node
}
```

---

### Junior → FAANG: Building Intuition Through Implementation

Implementing a simple blockchain in Go is not a toy exercise but the fastest path to accurate intuition about the guarantees and limitations of production blockchains. The implementation forces you to confront the exact moment where tamper-evidence is established (when you hash the block header including the previous hash) and the exact moment where it breaks (when you modify a field and do not rehash everything downstream).

The most important prerequisite for this exercise is understanding Go's `crypto/sha256` package and how to convert a struct into a deterministic byte sequence for hashing. JSON serialization via `encoding/json` is the simplest approach but has ordering surprises that bite beginners. Binary encoding with a defined field order is more representative of how real clients serialize block headers.

A worked example for first-job habit building: after implementing the basic chain, add a `Validate() error` method that checks every link in the chain and returns a descriptive error for the first invalid block. Then write a table-driven test that seeds a valid chain, mutates each field type in turn, and asserts that `Validate` catches each mutation. This testing discipline directly mirrors how production blockchain node code is tested.

For interview preparation, be able to explain why your simple blockchain does not prevent a single node from rewriting its own chain (there is no external consensus) and what you would need to add to make it Byzantine fault tolerant. This gap between a local chain and a networked consensus system is a classic follow-up question in blockchain system design screens.

### Senior @ FAANG: From Toy Implementation to Production Architecture Decisions

The simple blockchain implementation is the foundation for a much more important engineering skill: the ability to identify precisely which production properties are missing from a simplified model and to specify what engineering work closes each gap. At staff level, this analytical skill is used constantly when evaluating third-party blockchain clients, new Layer 2 systems, or internal proposals for custom chain implementations.

A systematic gap analysis of a toy blockchain implementation reveals several production concerns. First, the hash function choice matters: Keccak-256 for Ethereum compatibility, SHA-256 for Bitcoin compatibility, and BLAKE2/3 for newer chains optimized for performance. Using the wrong function in a system intended to verify proofs from a specific chain is a correctness error, not a performance concern. ADRs for any system that verifies block headers must specify and justify the hash function choice.

Second, the serialization format is a consensus-critical detail. The RLP (Recursive Length Prefix) encoding used by Ethereum and the Script serialization used by Bitcoin have specific canonical forms that every node must agree on. A simplified implementation that uses JSON will produce different hashes from a real node even if the field values are identical. Staff engineers reviewing cross-chain proof verification code must check that serialization matches the canonical form exactly.

Third, the nonce and difficulty adjustment logic in a proof-of-work implementation hides the entire economic security model. The real Bitcoin difficulty adjustment algorithm targets ten-minute block intervals by looking at the time of the last 2016 blocks. Deviating from this algorithm, even slightly, breaks the economic incentive structure. When evaluating a custom chain implementation, principal engineers audit the difficulty adjustment code before any other component.

At the L6 and above level, a team that has collectively implemented a blockchain from scratch (as part of onboarding or a hackathon) has a dramatically lower rate of architectural misunderstandings in production code. Investing in this kind of foundational exercise is a staff-level leadership decision, not just a learning activity.

Bar-raiser interviewers use the toy implementation as a starting point for escalating design challenges: "Your simple blockchain works. Now make it support 1000 nodes with Byzantine generals present. What changes?" Candidates who can trace the change from a hash-linked list to a BFT consensus protocol, naming the specific engineering concerns at each step, are demonstrating the architectural depth expected at senior levels.

The simplicity of a Go blockchain implementation also makes it the ideal place to introduce auditing and observability primitives: structured logging per block, metrics for block processing time, and trace IDs that correlate a transaction from submission through confirmation. Production blockchain clients are notoriously difficult to instrument after the fact. Starting with observability built in is a design principle that staff engineers enforce through code review and architecture review.

---
