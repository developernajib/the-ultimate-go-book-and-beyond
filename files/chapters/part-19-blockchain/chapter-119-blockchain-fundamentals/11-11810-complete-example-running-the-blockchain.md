## 119.10 Complete Example: Running the Blockchain

Let's tie everything together with a complete example.

```go
// main.go
package main

import (
	"encoding/hex"
	"fmt"
	"log"
	"time"
)

func main() {
	// Initialize blockchain database (in-memory for demo)
	db := NewMemoryDB()

	// Create wallets
	wallet1, _ := NewWallet()
	wallet2, _ := NewWallet()

	addr1 := wallet1.GetAddress()
	addr2 := wallet2.GetAddress()

	fmt.Printf("Wallet 1: %s\n", addr1)
	fmt.Printf("Wallet 2: %s\n\n", addr2)

	// Create blockchain with genesis block
	bc, err := NewBlockchain(db, addr1)
	if err != nil {
		log.Fatal(err)
	}

	// Mining reward goes to addr1
	fmt.Println("Genesis block mined!")
	fmt.Printf("Balance of %s: %d\n\n", addr1, bc.GetBalance(addr1))

	// Create and mine block with transaction
	time.Sleep(1 * time.Second)

	tx, err := NewUTXOTransaction(addr1, addr2, 10, bc)
	if err != nil {
		log.Fatal(err)
	}

	err = bc.AddBlock([]*Transaction{tx})
	if err != nil {
		log.Fatal(err)
	}

	fmt.Println("\nBlock 1 mined!")
	fmt.Printf("Balance of %s: %d\n", addr1, bc.GetBalance(addr1))
	fmt.Printf("Balance of %s: %d\n\n", addr2, bc.GetBalance(addr2))

	// Validate blockchain
	if bc.ValidateChain() {
		fmt.Println("Blockchain is valid!")
	} else {
		fmt.Println("Blockchain is invalid!")
	}

	// Print blockchain
	fmt.Println("\n=== Blockchain ===")
	iter := bc.Iterator()
	for iter.HasNext() {
		block := iter.Next()
		fmt.Println(block.String())

		pow := NewProofOfWork(block)
		fmt.Printf("  PoW Valid: %v\n\n", pow.Validate())
	}
}

// MemoryDB implements in-memory blockchain storage
type MemoryDB struct {
	blocks map[string]*Block
	height int
	tip    []byte
}

func NewMemoryDB() *MemoryDB {
	return &MemoryDB{
		blocks: make(map[string]*Block),
		height: -1,
	}
}

func (db *MemoryDB) SaveBlock(block *Block) error {
	key := hex.EncodeToString(block.Hash)
	db.blocks[key] = block
	db.height = block.Height
	db.tip = block.Hash
	return nil
}

func (db *MemoryDB) GetBlock(hash []byte) (*Block, error) {
	key := hex.EncodeToString(hash)
	if block, exists := db.blocks[key]; exists {
		return block, nil
	}
	return nil, fmt.Errorf("block not found")
}

func (db *MemoryDB) GetBlockByHeight(height int) (*Block, error) {
	for _, block := range db.blocks {
		if block.Height == height {
			return block, nil
		}
	}
	return nil, fmt.Errorf("block not found")
}

func (db *MemoryDB) GetLastBlock() (*Block, error) {
	if len(db.tip) == 0 {
		return nil, fmt.Errorf("no blocks")
	}
	return db.GetBlock(db.tip)
}

func (db *MemoryDB) GetHeight() int {
	return db.height
}
```

**Sample Output**:
```
Wallet 1: 1A2B3C4D5E6F7G8H9I0J
Wallet 2: 9Z8Y7X6W5V4U3T2S1R0Q

Genesis block mined!
Balance of 1A2B3C4D5E6F7G8H9I0J: 50

Mining block...
Found nonce: 98234
Block 1 mined!
Balance of 1A2B3C4D5E6F7G8H9I0J: 40
Balance of 9Z8Y7X6W5V4U3T2S1R0Q: 10

Blockchain is valid!

=== Blockchain ===
Block #1 [a3f2e1d0]
  PrevHash: 1b4c5d6e
  Time:     2025-12-07T10:30:45Z
  Nonce:    98234
  Txs:      1
  PoW Valid: true

Block #0 [1b4c5d6e]
  PrevHash: 00000000
  Time:     2025-12-07T10:30:30Z
  Nonce:    45123
  Txs:      1
  PoW Valid: true
```

---

### Junior → FAANG: Making Complete Examples Work in Practice

A complete blockchain example that runs end-to-end in Go is more valuable than any number of isolated code snippets, because it forces you to confront the integration points: how does the wallet connect to the node, how does the transaction get from constructed to confirmed, and how does the application learn about events without polling indefinitely? These integration challenges are exactly what real jobs require you to solve.

The prerequisite gap this example exposes is error handling under network conditions. In a local example, everything succeeds. In production, the RPC call to `eth_sendRawTransaction` may return a known error code (`nonce too low`, `replacement transaction underpriced`, `insufficient funds`) or may time out entirely. Every path through the submission and confirmation flow needs explicit handling, not just the happy path. Writing error handling for all documented error codes is a first-job discipline that separates reliable engineers from ones who need constant supervision.

For interview preparation, be able to run through the complete example mentally and explain each component's responsibility. The wallet manages keys and addresses. The RPC client communicates with the Ethereum node. The transaction builder constructs and signs. The broadcaster submits and monitors confirmation. This separation of concerns is a natural architecture for any blockchain integration and mirrors the structure interviewers expect when asking "how would you design an ETH deposit monitoring system?"

First-job habit: when you have a working complete example, write integration tests against a local Geth devmode node (started with `geth --dev`). These tests verify that your code produces correct on-chain state for each important scenario: normal transfer, failed transfer due to insufficient funds, failed transfer due to contract revert. Integration tests that run against a real (test) node are more valuable than mocked unit tests for blockchain interaction code because the RPC protocol has subtle behaviors that mocks often miss.

### Senior @ FAANG: Complete Examples as Reference Implementations and Onboarding Assets

At staff level, the "complete example" is a reference implementation: it encodes the team's decisions about error handling, retry logic, observability, and security for every junior and mid-level engineer who joins the team. The quality of this reference implementation directly determines how fast new team members reach production readiness. Investing staff-level engineering time in producing a high-quality reference implementation for common blockchain operations is a leverage-multiplying activity.

The reference implementation for an Ethereum integration at a production company should cover: transaction construction and signing with EIP-1559 fee management, nonce management with conflict resolution, transaction submission with retry logic including exponential backoff and fee bumping, receipt monitoring with reorg detection, and event log parsing with ABI decoding. Each component should have defined error types, structured logging with correlation IDs, and metrics exported in a format compatible with the team's observability stack.

ADRs that accompany reference implementations document the decisions that are baked in: why the team chose a specific gas price estimation strategy, why the confirmation depth is set to a specific value, why the nonce management uses a database-backed counter rather than on-chain query. These decisions will be revisited during incident reviews and refactoring discussions. Having them documented prevents the "why was this done this way?" conversation from consuming meeting time.

The complete example also serves as a test fixture. A Geth devmode node started with deterministic genesis (fixed chain ID, fixed initial account balances) allows tests to be reproducible and fast. Staff engineers maintain the devmode genesis configuration in version control and document the startup procedure so that any team member can reproduce the integration test environment locally or in CI.

Runbook integration is a staff-level responsibility that starts with the complete example. Every error path in the reference implementation should have a corresponding runbook entry that describes what the on-call engineer should do when that error appears in production. "Transaction stuck in mempool for more than 30 minutes" leads to a runbook for fee bump or cancellation. "RPC provider returning 429" leads to a runbook for switching to a backup provider. Writing these runbooks at the same time as the reference implementation ensures they are accurate and complete.

Bar-raiser signals: designing a complete example that handles Ethereum's separation of execution and consensus layers (the Engine API) for a custom application that needs to run an embedded Geth node, or explaining how the complete example changes when the target is a Layer 2 chain (different RPC endpoints, different finality model, different gas token mechanics on some L2s). These questions test whether the candidate can adapt a solid foundation to varied production environments.

L6 and L7 engineers use complete examples strategically during cross-team evangelism. When advocating for a new blockchain integration standard across multiple product teams, a working reference implementation that can be forked and adapted is far more persuasive than a design document. Staff engineers know that getting organizational alignment on infrastructure standards requires demonstrating working code, not just describing it.

---
