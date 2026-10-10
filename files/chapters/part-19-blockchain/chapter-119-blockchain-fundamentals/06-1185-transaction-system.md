## 119.5 Transaction System

### 5.1 UTXO Model (Bitcoin-style)

The Unspent Transaction Output (UTXO) model treats transactions as chains of ownership transfers. Each transaction consumes previous outputs and creates new ones.

```go
// transaction.go
package blockchain

import (
	"bytes"
	"crypto/sha256"
	"encoding/gob"
	"encoding/hex"
	"fmt"
	"log"
)

const subsidy = 50 // Mining reward

// Transaction represents a blockchain transaction
type Transaction struct {
	ID   []byte
	Vin  []TXInput
	Vout []TXOutput
}

// TXInput represents a transaction input
type TXInput struct {
	Txid      []byte // Previous transaction ID
	Vout      int    // Index of output in previous transaction
	Signature []byte // Digital signature
	PubKey    []byte // Public key
}

// TXOutput represents a transaction output
type TXOutput struct {
	Value      int    // Amount
	PubKeyHash []byte // Hash of recipient's public key
}

// NewCoinbaseTX creates a coinbase transaction (mining reward)
func NewCoinbaseTX(to, data string) *Transaction {
	if data == "" {
		data = fmt.Sprintf("Reward to '%s'", to)
	}

	txin := TXInput{
		Txid:      []byte{},
		Vout:      -1,
		Signature: nil,
		PubKey:    []byte(data),
	}

	txout := NewTXOutput(subsidy, to)

	tx := Transaction{
		ID:   nil,
		Vin:  []TXInput{txin},
		Vout: []TXOutput{*txout},
	}

	tx.ID = tx.Hash()

	return &tx
}

// NewUTXOTransaction creates a new transaction
func NewUTXOTransaction(from, to string, amount int, bc *Blockchain) (*Transaction, error) {
	var inputs []TXInput
	var outputs []TXOutput

	// Find spendable outputs
	acc, validOutputs := bc.FindSpendableOutputs(from, amount)

	if acc < amount {
		return nil, fmt.Errorf("not enough funds: have %d, need %d", acc, amount)
	}

	// Build inputs from outputs
	for txid, outs := range validOutputs {
		txID, err := hex.DecodeString(txid)
		if err != nil {
			return nil, fmt.Errorf("decode txid: %w", err)
		}

		for _, out := range outs {
			input := TXInput{
				Txid:      txID,
				Vout:      out,
				Signature: nil,
				PubKey:    []byte(from),
			}
			inputs = append(inputs, input)
		}
	}

	// Build outputs
	outputs = append(outputs, *NewTXOutput(amount, to))

	// Change output
	if acc > amount {
		outputs = append(outputs, *NewTXOutput(acc-amount, from))
	}

	tx := Transaction{
		ID:   nil,
		Vin:  inputs,
		Vout: outputs,
	}
	tx.ID = tx.Hash()

	// Sign transaction
	bc.SignTransaction(&tx, from)

	return &tx, nil
}

// NewTXOutput creates a new transaction output
func NewTXOutput(value int, address string) *TXOutput {
	txo := &TXOutput{Value: value}
	txo.Lock([]byte(address))

	return txo
}

// Lock locks an output with an address
func (out *TXOutput) Lock(address []byte) {
	// In real implementation, decode address and extract pubKeyHash
	// For simplicity, we'll hash the address
	hash := sha256.Sum256(address)
	out.PubKeyHash = hash[:]
}

// IsLockedWithKey checks if output is locked with specific key
func (out *TXOutput) IsLockedWithKey(pubKeyHash []byte) bool {
	return bytes.Equal(out.PubKeyHash, pubKeyHash)
}

// UsesKey checks if input uses specific key
func (in *TXInput) UsesKey(pubKeyHash []byte) bool {
	hash := sha256.Sum256(in.PubKey)
	return bytes.Equal(hash[:], pubKeyHash)
}

// IsCoinbase checks if transaction is coinbase
func (tx *Transaction) IsCoinbase() bool {
	return len(tx.Vin) == 1 && len(tx.Vin[0].Txid) == 0 && tx.Vin[0].Vout == -1
}

// Hash returns the hash of the transaction
func (tx *Transaction) Hash() []byte {
	var hash [32]byte

	txCopy := *tx
	txCopy.ID = []byte{}

	hash = sha256.Sum256(txCopy.Serialize())

	return hash[:]
}

// Serialize returns a serialized transaction
func (tx *Transaction) Serialize() []byte {
	var encoded bytes.Buffer

	enc := gob.NewEncoder(&encoded)
	err := enc.Encode(tx)
	if err != nil {
		log.Panic(err)
	}

	return encoded.Bytes()
}

// String returns human-readable transaction
func (tx *Transaction) String() string {
	return fmt.Sprintf(
		"Transaction %s:\n"+
			"  Inputs:  %d\n"+
			"  Outputs: %d\n"+
			"  Coinbase: %v\n",
		hex.EncodeToString(tx.ID[:8]),
		len(tx.Vin),
		len(tx.Vout),
		tx.IsCoinbase(),
	)
}
```

### 5.2 UTXO Set Management

`UTXOSet` caches the set of unspent outputs derived from the full chain so balance queries scan a compact index rather than re-traversing every block. `FindSpendableOutputs` accumulates outputs for an address until the target amount is reached, returning both the accumulated total and the map of transaction IDs to output indices needed to build the spending transaction.

```go
// utxo.go
package blockchain

import (
	"crypto/sha256"
	"encoding/hex"
)

// UTXOSet represents the set of unspent transaction outputs
type UTXOSet struct {
	Blockchain *Blockchain
}

// FindSpendableOutputs finds spendable outputs for an address
func (bc *Blockchain) FindSpendableOutputs(address string, amount int) (int, map[string][]int) {
	unspentOutputs := make(map[string][]int)
	unspentTXs := bc.FindUnspentTransactions(address)
	accumulated := 0

Work:
	for _, tx := range unspentTXs {
		txID := hex.EncodeToString(tx.ID)

		for outIdx, out := range tx.Vout {
			pubKeyHash := sha256.Sum256([]byte(address))
			if out.IsLockedWithKey(pubKeyHash[:]) && accumulated < amount {
				accumulated += out.Value
				unspentOutputs[txID] = append(unspentOutputs[txID], outIdx)

				if accumulated >= amount {
					break Work
				}
			}
		}
	}

	return accumulated, unspentOutputs
}

// FindUnspentTransactions finds transactions with unspent outputs
func (bc *Blockchain) FindUnspentTransactions(address string) []Transaction {
	var unspentTXs []Transaction
	spentTXOs := make(map[string][]int)

	bci := bc.Iterator()

	for bci.HasNext() {
		block := bci.Next()

		for _, tx := range block.Transactions {
			txID := hex.EncodeToString(tx.ID)

		Outputs:
			for outIdx, out := range tx.Vout {
				// Check if output was spent
				if spentTXOs[txID] != nil {
					for _, spentOut := range spentTXOs[txID] {
						if spentOut == outIdx {
							continue Outputs
						}
					}
				}

				pubKeyHash := sha256.Sum256([]byte(address))
				if out.IsLockedWithKey(pubKeyHash[:]) {
					unspentTXs = append(unspentTXs, *tx)
				}
			}

			// Mark inputs as spent
			if !tx.IsCoinbase() {
				for _, in := range tx.Vin {
					pubKeyHash := sha256.Sum256([]byte(address))
					if in.UsesKey(pubKeyHash[:]) {
						inTxID := hex.EncodeToString(in.Txid)
						spentTXOs[inTxID] = append(spentTXOs[inTxID], in.Vout)
					}
				}
			}
		}
	}

	return unspentTXs
}

// GetBalance calculates balance for an address
func (bc *Blockchain) GetBalance(address string) int {
	balance := 0
	unspentTXs := bc.FindUnspentTransactions(address)
	pubKeyHash := sha256.Sum256([]byte(address))

	for _, tx := range unspentTXs {
		for _, out := range tx.Vout {
			if out.IsLockedWithKey(pubKeyHash[:]) {
				balance += out.Value
			}
		}
	}

	return balance
}
```

### 5.3 Account Model (Ethereum-style)

The account model is simpler than UTXO - each account has a balance and nonce.

```go
// account.go
package blockchain

import (
	"fmt"
	"sync"
)

// AccountState represents account-based state
type AccountState struct {
	mu       sync.RWMutex
	accounts map[string]*Account
}

// Account represents an account in account model
type Account struct {
	Address string
	Balance int
	Nonce   int // Transaction counter for replay protection
}

// NewAccountState creates a new account state
func NewAccountState() *AccountState {
	return &AccountState{
		accounts: make(map[string]*Account),
	}
}

// GetAccount retrieves an account
func (as *AccountState) GetAccount(address string) *Account {
	as.mu.RLock()
	defer as.mu.RUnlock()

	if acc, exists := as.accounts[address]; exists {
		return acc
	}

	return &Account{Address: address, Balance: 0, Nonce: 0}
}

// Transfer transfers value between accounts
func (as *AccountState) Transfer(from, to string, amount int) error {
	as.mu.Lock()
	defer as.mu.Unlock()

	// Get or create accounts
	fromAcc := as.getOrCreate(from)
	toAcc := as.getOrCreate(to)

	// Validate balance
	if fromAcc.Balance < amount {
		return fmt.Errorf("insufficient balance: have %d, need %d",
			fromAcc.Balance, amount)
	}

	// Perform transfer
	fromAcc.Balance -= amount
	toAcc.Balance += amount
	fromAcc.Nonce++

	return nil
}

// getOrCreate gets or creates an account (must be called with lock held)
func (as *AccountState) getOrCreate(address string) *Account {
	if acc, exists := as.accounts[address]; exists {
		return acc
	}

	acc := &Account{Address: address, Balance: 0, Nonce: 0}
	as.accounts[address] = acc

	return acc
}

// GetBalance returns account balance
func (as *AccountState) GetBalance(address string) int {
	acc := as.GetAccount(address)
	return acc.Balance
}
```

---

### Junior → FAANG: Mastering the Transaction Lifecycle

The transaction system is the most operationally critical component of any blockchain integration. Every deposit, withdrawal, settlement, and state change flows through it. A junior engineer's first prerequisite to close is understanding the difference between a signed transaction and a broadcasted transaction: signing is a local operation using your private key, broadcasting is an asynchronous network operation whose success you must confirm independently.

The nonce is the most common source of first-job bugs in Ethereum transaction systems. The nonce is a per-account counter that must be exactly one higher than the previous confirmed transaction's nonce. A nonce gap (skipping a nonce value) causes all subsequent transactions from that account to be stuck in the mempool until the gap is filled. A duplicate nonce causes one transaction to replace the other (with potential loss of the replaced transaction's intent). Systems that submit transactions from multiple goroutines or processes must serialize nonce management through a single source of truth.

For interview preparation, practice explaining the full transaction validation rules: signature must be valid for the sender address, nonce must match the account's current nonce, sender must have enough ETH to cover `gas_limit * gas_price + value`, and the transaction data must not exceed the block gas limit. Interviewers use this walkthrough to verify that you understand validation as a state machine, not a black box.

Transaction fee markets changed significantly with EIP-1559 (August 2021). The new model uses a `baseFee` (protocol-determined and burned) plus an optional `priorityFee` (miner tip). Understanding why this matters: the base fee adjusts block by block based on how full the previous block was. A system that sets gas price statically will either consistently overpay or consistently have transactions stuck during network congestion. First-job habit: always use a gas price oracle or the `eth_maxPriorityFeePerGas` API, and implement retry logic with fee bumping for stuck transactions.

### Senior @ FAANG: Designing Production Transaction Management Systems

At staff level, the transaction system is a distributed system problem with economic consequences for every failure mode. The primary architectural concern is that Ethereum's transaction model is stateful and sequential per address but the business logic that generates transactions is often concurrent and distributed. Reconciling these two facts requires a transaction management service that owns nonce assignment, fee estimation, resubmission, and state reconciliation as a coherent state machine.

ADRs for transaction management systems at FAANG-adjacent companies typically address: nonce source of truth (single service with distributed lock, or on-chain query with cache), fee estimation strategy (static percentile of recent fees, dynamic EIP-1559 estimation, or fee bump on time-to-confirmation SLO breach), transaction receipt confirmation policy (confirmation depth, reorg handling, finality waiting), and failure handling (what happens when a transaction has been pending for more than N minutes).

MEV (Maximal Extractable Value) is an increasingly important concern in transaction system design. Searchers and block builders routinely reorder, insert, and sandwich transactions in the mempool. For systems that execute large trades or liquidations, the naive approach of broadcasting to the public mempool allows front-running. Production-grade systems at DeFi protocols use private transaction submission through Flashbots Protect, MEV Blocker, or direct relationships with block builders to avoid this. Staff engineers own the decision of when to use private mempool infrastructure and what the trade-off is in terms of inclusion latency and builder trust.

The EIP-4844 blob transaction type (live since Dencun, March 2024) adds a new transaction category that carries data blobs for rollup data availability. Systems that operate Layer 2 sequencers or submit rollup data to Ethereum must handle blob transactions with their separate fee market, blob-specific gas accounting, and the fact that blob data is pruned from nodes after approximately 18 days. Designing storage and retrieval systems for rollup data that will outlive the on-chain blob availability window is a staff-level architectural concern.

Replay protection (EIP-155) is a transaction property that junior engineers often overlook. A transaction without chain ID in its signature can be replayed on any chain that uses the same signature scheme. This was exploited when Ethereum Classic split from Ethereum. Production transaction systems must always include the chain ID in the signature and must validate chain ID on receipt parsing. Staff engineers verify this through code review and may enforce it through a linting rule or CI check.

Transaction monitoring and observability at production scale requires more than checking `eth_getTransactionReceipt`. Systems must detect stuck transactions (nonce gap, underpriced gas), failed transactions (out of gas, revert), and successful transactions that were confirmed on a fork that was subsequently orphaned. Building a monitoring system that correctly distinguishes these states and alerts appropriately requires understanding the Ethereum client's internal state machine, not just the public RPC API.

Bar-raiser signals: designing a transaction submission system that handles 10,000 transactions per hour from a single Ethereum account (requires nonce management with predictive assignment, parallel signing, and controlled submission), or explaining how EIP-4337 account abstraction changes the transaction fee payment model by allowing contracts to sponsor gas fees for users. These topics reveal whether a candidate has kept pace with protocol evolution.

At the L7 level, transaction system design intersects with regulatory compliance. Travel rule compliance (FATF Recommendation 16) requires that asset transfers above a threshold include originator and beneficiary information transmitted off-chain between VASPs. This requirement does not fit neatly onto Ethereum's transaction model and requires additional messaging infrastructure. Principal engineers at exchanges and regulated DeFi protocols design these systems to satisfy the regulatory requirement without compromising the privacy of compliant users.

---
