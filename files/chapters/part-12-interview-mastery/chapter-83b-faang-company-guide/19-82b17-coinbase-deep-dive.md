## 83B.17 Coinbase Deep Dive

### Overview for Go Engineers

Coinbase is the largest publicly traded cryptocurrency exchange in the United States. Go is a first-class language at Coinbase, powering their trading infrastructure, blockchain integration services, wallet APIs, and internal platform tools. Coinbase's engineering challenges are unlike almost any other company: every system must handle real money moving on immutable public blockchains, where mistakes cannot be undone by a database rollback. Engineers work on order book matching engines, blockchain transaction broadcasting, KYC/AML compliance pipelines, crypto wallet key management (HSMs), and real-time market data feeds. The interview process is technical and finance-aware - you should understand how blockchains work, how UTXOs vs. account models differ, and how order matching works. Security is paramount: Coinbase stores billions of dollars of customer funds, and a bug in their key management system could be catastrophic. Go engineers are valued for their ability to write concurrent, correct, and auditable code in a domain where correctness is existential.

### Interview Process

Coinbase's loop pairs standard technical rounds with a strong emphasis on security thinking and operating under regulatory constraints:

```
┌──────────────────────────────────────────────────────────────────┐
│                  COINBASE INTERVIEW PIPELINE                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │  - Experience, crypto interest, role fit                 │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - Coding + basic blockchain/finance concepts            │
│       ▼                                                          │
│  Virtual Onsite (4-5 rounds, 60 min each)                        │
│       │  - 2 Coding rounds (algorithms + blockchain problems)    │
│       │  - 1 System Design round (exchange/blockchain focus)     │
│       │  - 1 Security/Compliance round                           │
│       │  - 1 Behavioral round                                    │
│       ▼                                                          │
│  Offer                                                           │
│  Timeline: 3-5 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

The Security/Compliance round is unique to Coinbase. Expect questions about threat modeling for a crypto exchange, key management (cold vs. hot wallets, HSMs, multi-sig), KYC/AML regulatory requirements, and how to build systems that can withstand insider threats and external attacks. Demonstrating awareness of real-world crypto exchange hacks (Mt. Gox, FTX, Bybit) shows genuine preparation.

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| L4 | Software Engineer | 0-3 | $160K-$195K | $230K-$380K | Coding + crypto basics |
| L5 | Senior Engineer | 3-7 | $200K-$250K | $380K-$560K | System design + security |
| L6 | Staff Engineer | 7-12 | $250K-$320K | $560K-$780K | Architecture + compliance |
| L7 | Principal Engineer | 12+ | $310K-$400K | $780K-$1.1M+ | Cross-org technical strategy |

### Representative Interview Problems

#### Problem 1: Bitcoin UTXO Selection (Easy)

*Select UTXOs to fund a Bitcoin transaction, minimizing change and transaction fees.*

```go
package main

import (
	"fmt"
	"slices"
)

type UTXO struct {
	TxID   string
	Index  int
	Amount int64 // satoshis
}

type UTXOSelection struct {
	Selected   []UTXO
	TotalInput int64
	Change     int64
	Fee        int64
}

// SelectUTXOs uses a greedy approach: sort descending, select until we have enough.
// Production Coinbase uses Branch and Bound for optimal selection.
func SelectUTXOs(utxos []UTXO, targetAmount, feePerByte, txBaseBytes int64) (*UTXOSelection, error) {
	sorted := make([]UTXO, len(utxos))
	copy(sorted, utxos)
	slices.SortFunc(sorted, func(a, b UTXO) int {
		if a.Amount > b.Amount {
			return -1
		} else if a.Amount < b.Amount {
			return 1
		}
		return 0
	})

	var selected []UTXO
	var totalInput int64
	inputBytes := txBaseBytes

	for _, utxo := range sorted {
		selected = append(selected, utxo)
		totalInput += utxo.Amount
		inputBytes += 148 // ~148 bytes per P2PKH input

		fee := feePerByte * inputBytes
		if totalInput >= targetAmount+fee {
			change := totalInput - targetAmount - fee
			return &UTXOSelection{
				Selected:   selected,
				TotalInput: totalInput,
				Change:     change,
				Fee:        fee,
			}, nil
		}
	}
	return nil, fmt.Errorf("insufficient funds: have %d satoshis, need %d", totalInput, targetAmount)
}

func main() {
	utxos := []UTXO{
		{TxID: "abc1", Index: 0, Amount: 50000},
		{TxID: "abc2", Index: 1, Amount: 20000},
		{TxID: "abc3", Index: 0, Amount: 80000},
		{TxID: "abc4", Index: 2, Amount: 15000},
	}

	target := int64(60000) // 0.0006 BTC
	result, err := SelectUTXOs(utxos, target, 10, 10) // 10 sat/byte fee rate
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}

	fmt.Printf("Selected %d UTXOs, total input: %d sats\n", len(result.Selected), result.TotalInput)
	fmt.Printf("Target: %d sats, Fee: %d sats, Change: %d sats\n", target, result.Fee, result.Change)
	for _, u := range result.Selected {
		fmt.Printf("  UTXO %s:%d = %d sats\n", u.TxID[:6], u.Index, u.Amount)
	}
}
```

#### Problem 2: Crypto Order Book (Easy)

*Implement a limit order book for BTC/USD - the core data structure of a crypto exchange.*

```go
package main

import (
	"container/heap"
	"fmt"
)

type Order struct {
	ID    string
	Side  string // "buy" or "sell"
	Price int64  // in cents (USD)
	Qty   int64  // in satoshis
}

// BuyBook is a max-heap (highest bid first).
type BuyBook []Order
func (h BuyBook) Len() int            { return len(h) }
func (h BuyBook) Less(i, j int) bool  { return h[i].Price > h[j].Price }
func (h BuyBook) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *BuyBook) Push(x any)         { *h = append(*h, x.(Order)) }
func (h *BuyBook) Pop() any           { old := *h; n := len(old); x := old[n-1]; *h = old[:n-1]; return x }

// SellBook is a min-heap (lowest ask first).
type SellBook []Order
func (h SellBook) Len() int            { return len(h) }
func (h SellBook) Less(i, j int) bool  { return h[i].Price < h[j].Price }
func (h SellBook) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *SellBook) Push(x any)         { *h = append(*h, x.(Order)) }
func (h *SellBook) Pop() any           { old := *h; n := len(old); x := old[n-1]; *h = old[:n-1]; return x }

type OrderBook struct {
	buys  *BuyBook
	sells *SellBook
}

func NewOrderBook() *OrderBook {
	b, s := &BuyBook{}, &SellBook{}
	heap.Init(b)
	heap.Init(s)
	return &OrderBook{buys: b, sells: s}
}

type Fill struct {
	BuyID  string
	SellID string
	Price  int64
	Qty    int64
}

func (ob *OrderBook) PlaceOrder(order Order) []Fill {
	var fills []Fill
	if order.Side == "buy" {
		for ob.sells.Len() > 0 && (*ob.sells)[0].Price <= order.Price && order.Qty > 0 {
			best := heap.Pop(ob.sells).(Order)
			fillQty := min(order.Qty, best.Qty)
			fills = append(fills, Fill{order.ID, best.ID, best.Price, fillQty})
			order.Qty -= fillQty
			best.Qty -= fillQty
			if best.Qty > 0 {
				heap.Push(ob.sells, best)
			}
		}
		if order.Qty > 0 {
			heap.Push(ob.buys, order)
		}
	} else { // sell
		for ob.buys.Len() > 0 && (*ob.buys)[0].Price >= order.Price && order.Qty > 0 {
			best := heap.Pop(ob.buys).(Order)
			fillQty := min(order.Qty, best.Qty)
			fills = append(fills, Fill{best.ID, order.ID, best.Price, fillQty})
			order.Qty -= fillQty
			best.Qty -= fillQty
			if best.Qty > 0 {
				heap.Push(ob.buys, best)
			}
		}
		if order.Qty > 0 {
			heap.Push(ob.sells, order)
		}
	}
	return fills
}

func main() {
	ob := NewOrderBook()

	ob.PlaceOrder(Order{ID: "b1", Side: "buy", Price: 4500000, Qty: 100000})   // buy 0.001 BTC at $45000
	ob.PlaceOrder(Order{ID: "b2", Side: "buy", Price: 4480000, Qty: 200000})
	ob.PlaceOrder(Order{ID: "s1", Side: "sell", Price: 4520000, Qty: 150000})

	fills := ob.PlaceOrder(Order{ID: "s2", Side: "sell", Price: 4490000, Qty: 120000})
	for _, f := range fills {
		fmt.Printf("Fill: buy=%s sell=%s price=$%.2f qty=%d sats\n",
			f.BuyID, f.SellID, float64(f.Price)/100, f.Qty)
	}

	fmt.Printf("Best bid: $%.2f | Best ask: $%.2f\n",
		float64((*ob.buys)[0].Price)/100,
		float64((*ob.sells)[0].Price)/100)
}
```

#### Problem 3: Blockchain Transaction Validator (Easy)

*Validate an Ethereum-style transaction: signature, nonce ordering, and balance sufficiency.*

```go
package main

import (
	"errors"
	"fmt"
)

type EthTransaction struct {
	From     string
	To       string
	Value    int64 // in wei (smallest ETH unit)
	Nonce    int64
	GasLimit int64
	GasPrice int64
	Sig      string // simplified
}

type AccountState struct {
	Balance int64
	Nonce   int64
}

type TransactionValidator struct {
	accounts map[string]*AccountState
}

func NewValidator() *TransactionValidator {
	return &TransactionValidator{accounts: map[string]*AccountState{
		"0xAlice": {Balance: 10_000_000_000, Nonce: 5},
		"0xBob":   {Balance: 500_000_000, Nonce: 0},
	}}
}

var (
	ErrInsufficientFunds    = errors.New("insufficient funds")
	ErrInvalidNonce         = errors.New("invalid nonce")
	ErrInvalidSignature     = errors.New("invalid signature")
	ErrGasLimitTooLow       = errors.New("gas limit too low")
)

func (v *TransactionValidator) Validate(tx EthTransaction) error {
	acct, ok := v.accounts[tx.From]
	if !ok {
		return fmt.Errorf("unknown account: %s", tx.From)
	}

	// Nonce check: must be exactly current nonce
	if tx.Nonce != acct.Nonce {
		return fmt.Errorf("%w: expected %d got %d", ErrInvalidNonce, acct.Nonce, tx.Nonce)
	}

	// Signature check (simplified)
	if tx.Sig == "" {
		return ErrInvalidSignature
	}

	// Gas minimum check
	const minGasTransfer = int64(21000)
	if tx.GasLimit < minGasTransfer {
		return fmt.Errorf("%w: minimum %d", ErrGasLimitTooLow, minGasTransfer)
	}

	// Balance sufficiency: value + gas cost
	gasCost := tx.GasLimit * tx.GasPrice
	totalCost := tx.Value + gasCost
	if acct.Balance < totalCost {
		return fmt.Errorf("%w: have %d need %d", ErrInsufficientFunds, acct.Balance, totalCost)
	}
	return nil
}

func (v *TransactionValidator) Apply(tx EthTransaction) error {
	if err := v.Validate(tx); err != nil {
		return err
	}
	gasCost := tx.GasLimit * tx.GasPrice
	v.accounts[tx.From].Balance -= tx.Value + gasCost
	v.accounts[tx.From].Nonce++
	if _, ok := v.accounts[tx.To]; !ok {
		v.accounts[tx.To] = &AccountState{}
	}
	v.accounts[tx.To].Balance += tx.Value
	return nil
}

func main() {
	v := NewValidator()

	txs := []EthTransaction{
		{From: "0xAlice", To: "0xBob", Value: 1_000_000_000, Nonce: 5, GasLimit: 21000, GasPrice: 20, Sig: "valid"},
		{From: "0xAlice", To: "0xBob", Value: 1_000_000_000, Nonce: 5, GasLimit: 21000, GasPrice: 20, Sig: "valid"}, // wrong nonce
		{From: "0xBob", To: "0xAlice", Value: 999_000_000_000, Nonce: 0, GasLimit: 21000, GasPrice: 20, Sig: "valid"}, // insufficient funds
	}

	for _, tx := range txs {
		err := v.Apply(tx)
		fmt.Printf("TX from=%s nonce=%d: %v\n", tx.From, tx.Nonce, func() string {
			if err == nil { return "SUCCESS" }
			return err.Error()
		}())
	}
}
```

#### Problem 4: Blockchain Merkle Tree for Transaction Inclusion Proof (Medium)

*Build the Bitcoin-style Merkle tree used to prove a transaction is included in a block.*

```go
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

func dblSHA256(data []byte) string {
	h1 := sha256.Sum256(data)
	h2 := sha256.Sum256(h1[:])
	return hex.EncodeToString(h2[:])
}

func hashPairBTC(left, right string) string {
	combined, _ := hex.DecodeString(left + right)
	return dblSHA256(combined)
}

type MerkleProof struct {
	TxID   string
	Path   []struct{ Hash string; IsLeft bool }
	Root   string
}

func BuildMerkleTree(txIDs []string) (root string, levels [][]string) {
	if len(txIDs) == 0 {
		return "", nil
	}
	current := make([]string, len(txIDs))
	copy(current, txIDs)
	levels = append(levels, current)

	for len(current) > 1 {
		if len(current)%2 != 0 {
			current = append(current, current[len(current)-1]) // duplicate last
		}
		var next []string
		for i := 0; i < len(current); i += 2 {
			next = append(next, hashPairBTC(current[i], current[i+1]))
		}
		levels = append(levels, next)
		current = next
	}
	return current[0], levels
}

func GenerateProof(txIDs []string, targetTxID string) (*MerkleProof, error) {
	root, levels := BuildMerkleTree(txIDs)

	idx := -1
	for i, tx := range txIDs {
		if tx == targetTxID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil, fmt.Errorf("txID %s not found", targetTxID)
	}

	proof := &MerkleProof{TxID: targetTxID, Root: root}
	for _, level := range levels[:len(levels)-1] {
		siblingIdx := idx ^ 1
		if siblingIdx >= len(level) {
			siblingIdx = idx
		}
		proof.Path = append(proof.Path, struct{ Hash string; IsLeft bool }{
			Hash:   level[siblingIdx],
			IsLeft: siblingIdx < idx,
		})
		idx /= 2
	}
	return proof, nil
}

func VerifyProof(proof *MerkleProof) bool {
	current := proof.TxID
	for _, step := range proof.Path {
		if step.IsLeft {
			current = hashPairBTC(step.Hash, current)
		} else {
			current = hashPairBTC(current, step.Hash)
		}
	}
	return current == proof.Root
}

func main() {
	txIDs := []string{
		dblSHA256([]byte("tx1")),
		dblSHA256([]byte("tx2")),
		dblSHA256([]byte("tx3")),
		dblSHA256([]byte("tx4")),
	}

	root, _ := BuildMerkleTree(txIDs)
	fmt.Printf("Merkle root: %s...\n", root[:16])

	proof, err := GenerateProof(txIDs, txIDs[1])
	fmt.Printf("Proof for tx2: err=%v, path_depth=%d\n", err, len(proof.Path))
	fmt.Printf("Proof valid: %v\n", VerifyProof(proof))
}
```

#### Problem 5: KYC Risk Scoring Pipeline (Medium)

*Build a risk scoring pipeline for KYC (Know Your Customer) verification - required by FinCEN regulations.*

```go
package main

import (
	"fmt"
	"strings"
)

type KYCInput struct {
	UserID        string
	FullName      string
	Country       string
	DateOfBirth   string
	GovernmentID  string
	SelfieMatch   float64 // 0-1 face match score
	WatchlistHit  bool    // OFAC/SDN list check
	PEP           bool    // Politically Exposed Person
}

type KYCDecision struct {
	UserID   string
	Risk     string // "low", "medium", "high", "blocked"
	Score    int
	Reasons  []string
	Approved bool
}

type KYCRule func(KYCInput) (score int, reason string)

var kycRules = []KYCRule{
	// Rule 1: Watchlist hit - immediate block
	func(k KYCInput) (int, string) {
		if k.WatchlistHit {
			return 100, "OFAC/SDN watchlist hit"
		}
		return 0, ""
	},
	// Rule 2: High-risk country
	func(k KYCInput) (int, string) {
		highRisk := map[string]bool{"KP": true, "IR": true, "SY": true, "CU": true}
		if highRisk[k.Country] {
			return 80, fmt.Sprintf("high-risk jurisdiction: %s", k.Country)
		}
		return 0, ""
	},
	// Rule 3: Low selfie match score
	func(k KYCInput) (int, string) {
		if k.SelfieMatch < 0.70 {
			return 40, fmt.Sprintf("low biometric match: %.2f", k.SelfieMatch)
		} else if k.SelfieMatch < 0.85 {
			return 15, fmt.Sprintf("moderate biometric match: %.2f", k.SelfieMatch)
		}
		return 0, ""
	},
	// Rule 4: PEP flag
	func(k KYCInput) (int, string) {
		if k.PEP {
			return 30, "politically exposed person (PEP) - enhanced due diligence required"
		}
		return 0, ""
	},
	// Rule 5: Missing ID
	func(k KYCInput) (int, string) {
		if strings.TrimSpace(k.GovernmentID) == "" {
			return 60, "no government ID provided"
		}
		return 0, ""
	},
}

func EvaluateKYC(input KYCInput) KYCDecision {
	decision := KYCDecision{UserID: input.UserID}
	for _, rule := range kycRules {
		score, reason := rule(input)
		if score > 0 {
			decision.Score += score
			decision.Reasons = append(decision.Reasons, reason)
		}
	}
	decision.Score = min(decision.Score, 100)
	switch {
	case decision.Score >= 80:
		decision.Risk = "blocked"
		decision.Approved = false
	case decision.Score >= 50:
		decision.Risk = "high"
		decision.Approved = false // requires manual review
	case decision.Score >= 25:
		decision.Risk = "medium"
		decision.Approved = true // approved with enhanced monitoring
	default:
		decision.Risk = "low"
		decision.Approved = true
	}
	return decision
}

func main() {
	users := []KYCInput{
		{UserID: "u1", Country: "US", SelfieMatch: 0.95, GovernmentID: "DL-123456"},
		{UserID: "u2", Country: "US", SelfieMatch: 0.65, GovernmentID: "PP-789012"},
		{UserID: "u3", Country: "IR", SelfieMatch: 0.92, GovernmentID: "ID-555"},
		{UserID: "u4", Country: "US", SelfieMatch: 0.90, WatchlistHit: true, GovernmentID: "DL-999"},
		{UserID: "u5", Country: "GB", SelfieMatch: 0.88, PEP: true, GovernmentID: "PP-777"},
	}

	for _, u := range users {
		d := EvaluateKYC(u)
		fmt.Printf("User %s: risk=%-8s score=%3d approved=%-5v reasons=%v\n",
			d.UserID, d.Risk, d.Score, d.Approved, d.Reasons)
	}
}
```

#### Problem 6: Hot Wallet Balance Manager (Medium)

*Manage a hot wallet's BTC balance - auto-refill from cold storage when below threshold, cap outflows.*

```go
package main

import (
	"errors"
	"fmt"
	"sync"
)

var (
	ErrInsufficientHotBalance = errors.New("insufficient hot wallet balance")
	ErrExceedsOutflowLimit    = errors.New("exceeds daily outflow limit")
)

type WalletManager struct {
	mu              sync.Mutex
	hotBalance      int64 // satoshis
	coldBalance     int64
	refillThreshold int64
	refillAmount    int64
	dailyOutflow    int64
	dailyOutflowMax int64
}

func NewWalletManager(hotBal, coldBal, refillThreshold, refillAmount, dailyMax int64) *WalletManager {
	return &WalletManager{
		hotBalance:      hotBal,
		coldBalance:     coldBal,
		refillThreshold: refillThreshold,
		refillAmount:    refillAmount,
		dailyOutflowMax: dailyMax,
	}
}

func (wm *WalletManager) Withdraw(amount int64) error {
	wm.mu.Lock()
	defer wm.mu.Unlock()

	if wm.dailyOutflow+amount > wm.dailyOutflowMax {
		return fmt.Errorf("%w: daily limit %d, used %d, requested %d",
			ErrExceedsOutflowLimit, wm.dailyOutflowMax, wm.dailyOutflow, amount)
	}
	if wm.hotBalance < amount {
		return fmt.Errorf("%w: hot balance %d < requested %d", ErrInsufficientHotBalance, wm.hotBalance, amount)
	}

	wm.hotBalance -= amount
	wm.dailyOutflow += amount

	// Auto-refill from cold storage
	if wm.hotBalance < wm.refillThreshold && wm.coldBalance >= wm.refillAmount {
		transferred := min(wm.refillAmount, wm.coldBalance)
		wm.hotBalance += transferred
		wm.coldBalance -= transferred
		fmt.Printf("  [auto-refill] transferred %d sats from cold to hot wallet\n", transferred)
	}
	return nil
}

func (wm *WalletManager) Status() string {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	return fmt.Sprintf("hot=%d sats, cold=%d sats, daily_outflow=%d/%d",
		wm.hotBalance, wm.coldBalance, wm.dailyOutflow, wm.dailyOutflowMax)
}

func main() {
	mgr := NewWalletManager(
		5_000_000,  // hot: 0.05 BTC
		500_000_000, // cold: 5 BTC
		1_000_000,  // refill threshold: 0.01 BTC
		10_000_000, // refill amount: 0.1 BTC
		20_000_000, // daily max outflow: 0.2 BTC
	)

	withdrawals := []int64{2_000_000, 2_000_000, 500_000, 25_000_000}
	for _, w := range withdrawals {
		err := mgr.Withdraw(w)
		status := fmt.Sprintf("withdraw %d sats:", w)
		if err != nil {
			fmt.Printf("%-30s ERROR: %v\n", status, err)
		} else {
			fmt.Printf("%-30s OK | %s\n", status, mgr.Status())
		}
	}
}
```

#### Problem 7: On-Chain Transaction Confirmation Tracker (Medium)

*Track blockchain transaction confirmations and trigger actions when sufficient confirmations are reached.*

```go
package main

import (
	"fmt"
	"sync"
)

type PendingTx struct {
	TxHash        string
	AmountSats    int64
	RequiredConfs int
	CurrentConfs  int
	Callbacks     []func(txHash string, confs int)
}

type ConfirmationTracker struct {
	mu      sync.Mutex
	pending map[string]*PendingTx
}

func NewConfirmationTracker() *ConfirmationTracker {
	return &ConfirmationTracker{pending: make(map[string]*PendingTx)}
}

func (ct *ConfirmationTracker) Watch(txHash string, amount int64, requiredConfs int, cb func(string, int)) {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if tx, exists := ct.pending[txHash]; exists {
		tx.Callbacks = append(tx.Callbacks, cb)
		return
	}
	ct.pending[txHash] = &PendingTx{
		TxHash:        txHash,
		AmountSats:    amount,
		RequiredConfs: requiredConfs,
		Callbacks:     []func(string, int){cb},
	}
}

// OnNewBlock simulates a new block being mined, incrementing confirmations.
func (ct *ConfirmationTracker) OnNewBlock(blockHeight int) {
	ct.mu.Lock()
	defer ct.mu.Unlock()

	var toDelete []string
	for hash, tx := range ct.pending {
		tx.CurrentConfs++
		fmt.Printf("  [block %d] tx=%s confs=%d/%d\n", blockHeight, hash[:8], tx.CurrentConfs, tx.RequiredConfs)

		if tx.CurrentConfs >= tx.RequiredConfs {
			for _, cb := range tx.Callbacks {
				cb(tx.TxHash, tx.CurrentConfs)
			}
			toDelete = append(toDelete, hash)
		}
	}
	for _, h := range toDelete {
		delete(ct.pending, h)
	}
}

func main() {
	tracker := NewConfirmationTracker()

	// Watch a BTC deposit - requires 6 confirmations before crediting
	tracker.Watch("a1b2c3d4e5f6...", 500_000, 6, func(txHash string, confs int) {
		fmt.Printf("\n✓ TX %s confirmed (%d confs) - crediting customer account\n", txHash[:8], confs)
	})

	// Simulate 7 new blocks
	for block := range 7 {
		tracker.OnNewBlock(800000 + block)
	}
}
```

#### Problem 8: Multi-Signature Transaction Authorization (Hard)

*Implement an M-of-N multi-signature scheme for authorizing large crypto transactions - required for Coinbase's institutional custody.*

```go
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

type Signer struct {
	ID        string
	PublicKey string // simplified as string
}

func (s Signer) Sign(txHash string) string {
	// Simplified: in production use ECDSA/Ed25519
	h := sha256.Sum256([]byte(s.PublicKey + ":" + txHash))
	return hex.EncodeToString(h[:])
}

type MultiSigPolicy struct {
	Required int
	Signers  []Signer
}

type MultiSigTx struct {
	Hash       string
	Amount     int64
	Recipients map[string]int64
	Signatures map[string]string // signerID → signature
}

var (
	ErrInvalidSignature    = errors.New("invalid signature")
	ErrThresholdNotMet     = errors.New("insufficient valid signatures")
	ErrUnauthorizedSigner  = errors.New("unauthorized signer")
)

func (p *MultiSigPolicy) ValidateSigner(signerID string) bool {
	for _, s := range p.Signers {
		if s.ID == signerID {
			return true
		}
	}
	return false
}

func (p *MultiSigPolicy) Authorize(tx *MultiSigTx) error {
	validCount := 0
	for signerID, sig := range tx.Signatures {
		if !p.ValidateSigner(signerID) {
			return fmt.Errorf("%w: %s", ErrUnauthorizedSigner, signerID)
		}
		// Find signer
		for _, s := range p.Signers {
			if s.ID == signerID {
				expectedSig := s.Sign(tx.Hash)
				if sig != expectedSig {
					return fmt.Errorf("%w from signer %s", ErrInvalidSignature, signerID)
				}
				validCount++
			}
		}
	}
	if validCount < p.Required {
		return fmt.Errorf("%w: need %d have %d", ErrThresholdNotMet, p.Required, validCount)
	}
	return nil
}

func main() {
	signers := []Signer{
		{ID: "cfo", PublicKey: "pk_cfo_abc123"},
		{ID: "cto", PublicKey: "pk_cto_def456"},
		{ID: "ciso", PublicKey: "pk_ciso_ghi789"},
		{ID: "vault", PublicKey: "pk_vault_jkl012"},
	}

	// 3-of-4 policy for large withdrawals
	policy := &MultiSigPolicy{Required: 3, Signers: signers}

	txHash := "7f3e2a1b8c9d0e4f..."
	tx := &MultiSigTx{
		Hash:       txHash,
		Amount:     1_000_000_000, // 10 BTC
		Recipients: map[string]int64{"1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf": 1_000_000_000},
		Signatures: make(map[string]string),
	}

	// CFO, CTO, CISO sign (3-of-4 met)
	for _, s := range signers[:3] {
		tx.Signatures[s.ID] = s.Sign(txHash)
	}

	err := policy.Authorize(tx)
	fmt.Printf("3-of-4 signatures: authorized=%v err=%v\n", err == nil, err)

	// Only 2 signatures (insufficient)
	tx2 := &MultiSigTx{Hash: txHash, Signatures: map[string]string{
		signers[0].ID: signers[0].Sign(txHash),
		signers[1].ID: signers[1].Sign(txHash),
	}}
	err = policy.Authorize(tx2)
	fmt.Printf("2-of-4 signatures: authorized=%v err=%v\n", err == nil, err)
}
```

#### Problem 9: AML Transaction Monitoring (Hard)

*Detect structuring (smurfing) - splitting large amounts to evade AML reporting thresholds.*

```go
package main

import (
	"fmt"
	"time"
)

type Transaction struct {
	UserID    string
	Amount    int64 // USD cents
	Timestamp time.Time
	TxType    string // "deposit", "withdrawal"
}

type StructuringAlert struct {
	UserID    string
	Window    time.Duration
	TxCount   int
	TotalAmt  int64
	Threshold int64
	Reason    string
}

type AMLMonitor struct {
	// In production: backed by Redis or time-series DB
	txHistory map[string][]Transaction
	threshold int64         // reporting threshold (e.g., $10,000)
	window    time.Duration // rolling window
}

func NewAMLMonitor(threshold int64, window time.Duration) *AMLMonitor {
	return &AMLMonitor{
		txHistory: make(map[string][]Transaction),
		threshold: threshold,
		window:    window,
	}
}

func (m *AMLMonitor) Record(tx Transaction) *StructuringAlert {
	now := tx.Timestamp
	cutoff := now.Add(-m.window)

	// Evict old transactions
	history := m.txHistory[tx.UserID]
	start := 0
	for start < len(history) && history[start].Timestamp.Before(cutoff) {
		start++
	}
	history = history[start:]
	history = append(history, tx)
	m.txHistory[tx.UserID] = history

	// Structuring detection: multiple transactions totaling >= threshold
	// where each individual transaction is just below threshold
	var totalAmt int64
	justBelow := int64(float64(m.threshold) * 0.9) // 90% of threshold
	structuringCount := 0

	for _, h := range history {
		totalAmt += h.Amount
		if h.Amount >= justBelow && h.Amount < m.threshold {
			structuringCount++
		}
	}

	if totalAmt >= m.threshold && structuringCount >= 2 {
		return &StructuringAlert{
			UserID:    tx.UserID,
			Window:    m.window,
			TxCount:   len(history),
			TotalAmt:  totalAmt,
			Threshold: m.threshold,
			Reason:    fmt.Sprintf("%d transactions just below threshold totaling $%.2f", structuringCount, float64(totalAmt)/100),
		}
	}
	return nil
}

func main() {
	monitor := NewAMLMonitor(1_000_000, 24*time.Hour) // $10,000 threshold, 24h window

	now := time.Now()
	// Simulate structuring: 3 deposits of ~$9,500 each
	deposits := []Transaction{
		{UserID: "u123", Amount: 950_000, TxType: "deposit", Timestamp: now.Add(-6 * time.Hour)},
		{UserID: "u123", Amount: 940_000, TxType: "deposit", Timestamp: now.Add(-3 * time.Hour)},
		{UserID: "u123", Amount: 960_000, TxType: "deposit", Timestamp: now},
	}

	for _, tx := range deposits {
		alert := monitor.Record(tx)
		if alert != nil {
			fmt.Printf("\n⚠ AML ALERT for user %s:\n", alert.UserID)
			fmt.Printf("  Reason: %s\n", alert.Reason)
			fmt.Printf("  Total: $%.2f in %v window\n", float64(alert.TotalAmt)/100, alert.Window)
		} else {
			fmt.Printf("TX $%.2f recorded (no alert)\n", float64(tx.Amount)/100)
		}
	}
}
```

#### Problem 10: Crypto Portfolio Risk Engine (Hard)

*Calculate Value at Risk (VaR) for a crypto portfolio using historical simulation.*

```go
package main

import (
	"fmt"
	"math"
	"slices"
)

type Position struct {
	Symbol   string
	Quantity float64 // in crypto units
	Price    float64 // current price USD
}

type DailyReturn struct {
	Symbol string
	Return float64 // daily % change
}

// HistoricalReturns simulates 30 days of daily returns for each asset.
// In production: use actual market data.
func HistoricalReturns() [][]DailyReturn {
	// Simulated daily returns (crypto is volatile: ±5-15% daily)
	data := map[string][]float64{
		"BTC":  {0.03, -0.05, 0.08, -0.02, 0.04, -0.07, 0.06, -0.03, 0.02, -0.08, 0.05, -0.04, 0.09, -0.01, 0.03, -0.06, 0.07, -0.02, 0.04, -0.09, 0.05, -0.03, 0.08, -0.05, 0.02, -0.04, 0.06, -0.07, 0.03, -0.02},
		"ETH":  {0.04, -0.06, 0.10, -0.03, 0.05, -0.08, 0.07, -0.04, 0.03, -0.10, 0.06, -0.05, 0.11, -0.02, 0.04, -0.07, 0.08, -0.03, 0.05, -0.11, 0.06, -0.04, 0.09, -0.06, 0.03, -0.05, 0.07, -0.08, 0.04, -0.03},
	}

	days := 30
	scenarios := make([][]DailyReturn, days)
	for i := range days {
		for symbol, returns := range data {
			scenarios[i] = append(scenarios[i], DailyReturn{symbol, returns[i]})
		}
	}
	return scenarios
}

// PortfolioValueAtRisk computes the 1-day VaR at a given confidence level (e.g., 0.95).
func PortfolioValueAtRisk(positions []Position, scenarios [][]DailyReturn, confidence float64) (varUSD float64) {
	// Current portfolio value
	portfolioValue := 0.0
	for _, p := range positions {
		portfolioValue += p.Quantity * p.Price
	}

	// Calculate PnL for each historical scenario
	pnls := make([]float64, len(scenarios))
	for i, scenario := range scenarios {
		returnBySymbol := make(map[string]float64)
		for _, r := range scenario {
			returnBySymbol[r.Symbol] = r.Return
		}
		var scenarioPnL float64
		for _, p := range positions {
			ret := returnBySymbol[p.Symbol]
			scenarioPnL += p.Quantity * p.Price * ret
		}
		pnls[i] = scenarioPnL
	}

	// Sort PnL ascending (worst losses first)
	slices.Sort(pnls)

	// VaR = loss at (1-confidence) percentile
	varIdx := int(math.Floor(float64(len(pnls)) * (1 - confidence)))
	varIdx = max(0, min(varIdx, len(pnls)-1))
	return -pnls[varIdx] // return as positive loss figure
}

func main() {
	positions := []Position{
		{Symbol: "BTC", Quantity: 0.5, Price: 95000},   // $47,500
		{Symbol: "ETH", Quantity: 10.0, Price: 3500},   // $35,000
	}

	totalValue := 0.0
	for _, p := range positions {
		totalValue += p.Quantity * p.Price
	}

	scenarios := HistoricalReturns()
	var95 := PortfolioValueAtRisk(positions, scenarios, 0.95)
	var99 := PortfolioValueAtRisk(positions, scenarios, 0.99)

	fmt.Printf("Portfolio value: $%.2f\n", totalValue)
	fmt.Printf("1-day VaR (95%% confidence): -$%.2f (%.1f%% of portfolio)\n", var95, var95/totalValue*100)
	fmt.Printf("1-day VaR (99%% confidence): -$%.2f (%.1f%% of portfolio)\n", var99, var99/totalValue*100)
}
```

---

### System Design Topics

**Top 5 Coinbase System Design Questions:**

1. **Design a Crypto Exchange Matching Engine** - Match buy/sell orders in real time with microsecond latency. Topics: order book data structures (priority queues), order types (limit/market/stop), FIFO price-time priority, partial fills, market depth aggregation, tick-by-tick market data.

2. **Design Coinbase's Hot/Cold Wallet Architecture** - Secure custody of billions in crypto assets. Topics: HSM (Hardware Security Module) integration, multi-sig policies, cold storage air-gap procedures, hot wallet thresholds, automatic refill automation, insider threat mitigation.

3. **Design a Blockchain Transaction Broadcaster** - Submit transactions to Bitcoin/Ethereum networks reliably. Topics: transaction mempool monitoring, fee estimation, stuck transaction detection (RBF/CPFP), confirmation tracking, multi-chain support, reorg handling.

4. **Design the AML Transaction Monitoring System** - Detect money laundering in real time across millions of daily transactions. Topics: streaming aggregation, pattern detection (structuring, layering, integration), SAR (Suspicious Activity Report) generation, false positive reduction, real-time vs. batch analysis.

5. **Design Coinbase's KYC Verification Pipeline** - Verify 100M+ customer identities at onboarding and ongoing. Topics: document verification (OCR, tampering detection), biometric matching, sanctions screening (OFAC), PEP checks, vendor integration (Persona, Jumio), manual review queue.

---

### Behavioral Focus

Coinbase's culture centers on **"Clear Communication," "Efficient Execution,"** and **"Positive Energy."** Behavioral themes:

- **Mission alignment:** "Why does financial access and cryptocurrency infrastructure matter to you as an engineer?"
- **Security mindset:** "Tell me about a time you identified a potential security vulnerability - how did you handle disclosure and remediation?"
- **Handling irreversibility:** "Describe a time you had to make a decision where mistakes could not be rolled back."
- **Regulatory awareness:** "How have you balanced engineering speed with compliance or regulatory constraints?"
- **Customer trust:** "Tell me about a time a system you built handled real money - what extra care did you take?"

---

### Insider Tips

**Common Mistakes:**
- Not understanding blockchain basics (UTXO vs. account model, confirmations, transaction fees) - expect to be tested.
- Designing payment systems with database rollback as the recovery strategy (can't roll back an on-chain transaction).
- Ignoring the hot/cold wallet security architecture in custody system design.
- KYC/AML design without mentioning regulatory requirements (FinCEN, FATF, OFAC screening).

**Strong Hire Signals:**
- Mentioning multi-sig and HSMs in wallet design without prompting.
- Discussing structuring detection in AML design.
- Understanding transaction finality (probabilistic on Bitcoin, deterministic on Ethereum post-merge).
- Proposing idempotency for blockchain transaction submission (network retries).

**Red Flags:**
- Using floating-point for cryptocurrency amounts (always use integer satoshis/wei/gwei).
- Designing hot wallet with no automatic refill and cold storage procedures.
- Not discussing KYC/AML regulatory context in compliance-related designs.

---

### 8-Week Preparation Timeline

```
Week 1: Blockchain Fundamentals
  Mon-Tue: Bitcoin UTXO model, transaction structure, Merkle trees
  Wed-Thu: Ethereum account model, gas, EVM basics
  Fri:     Consensus mechanisms (PoW vs PoS), finality concepts
  Weekend: Implement UTXO selector and order book in Go

Week 2: Financial Systems & Security
  Mon-Tue: Order book matching engines, price-time priority
  Wed-Thu: Hot/cold wallet architecture, HSM concepts, multi-sig
  Fri:     KYC/AML regulations (FinCEN, FATF, OFAC basics)
  Weekend: Build AML structuring detector and KYC risk scorer

Week 3: Algorithms - Finance & Crypto
  Mon-Fri: 2 problems/day - heaps, priority queues, sliding windows
  Weekend: Merkle tree + inclusion proof implementation

Week 4: System Design - Exchange Systems
  Mon-Tue: Design crypto exchange matching engine (whiteboard)
  Wed-Thu: Design hot/cold wallet custody architecture
  Fri:     Design blockchain transaction broadcaster
  Weekend: Mock system design interview

Week 5: Compliance & Security Systems
  Mon-Tue: Design AML monitoring pipeline
  Wed-Thu: Design KYC verification pipeline
  Fri:     Zero-trust, threat modeling for financial systems
  Weekend: Security design review - threat model a crypto exchange

Week 6: Go for Financial Systems
  Mon-Tue: Integer arithmetic for crypto amounts (no floats)
  Wed-Thu: Concurrent order book operations, lock-free data structures
  Fri:     Error handling for irreversible operations
  Weekend: Build multi-sig authorization system in Go

Week 7: Regulatory & Domain Knowledge
  Mon-Tue: Study real crypto exchange incidents (security angle)
  Wed:     Mock security/compliance interview round
  Thu:     Behavioral stories - security, irreversibility, trust
  Fri:     Research Coinbase engineering blog
  Weekend: Full mock onsite

Week 8: Final Prep
  Mon-Tue: Review blockchain edge cases (reorgs, stuck transactions)
  Wed:     Full mock onsite (all rounds)
  Thu:     Rest, logistics
  Fri:     Light review only
```

---


### Junior → FAANG: Coinbase Interview Preparation Basics

Coinbase engineering interviews reflect its position as a financial infrastructure company for cryptocurrency. Core technical areas: blockchain fundamentals (transaction signing, UTXO versus account models, mempool management), high-reliability financial systems (idempotency, double-spend prevention, reconciliation), and regulatory compliance infrastructure (KYC/AML, transaction monitoring). Coding and system design interviews are standard in format. The domain knowledge requirement is higher than for typical software companies.

### Senior @ FAANG: Coinbase Senior and Staff: Financial Reliability and Blockchain Infrastructure

At the senior and staff level, Coinbase's engineering culture combines the reliability requirements of a financial institution with the fast-moving innovation culture of a tech company, which creates interesting tensions. Staff candidates should be able to discuss: cold wallet custody architecture (keys never touch internet-connected systems), hot wallet risk management (maximum exposure limits, automated circuit breakers), and the blockchain integration layer (monitoring mempools, estimating gas fees, handling chain reorganizations). The compliance engineering challenge is also significant at the staff level: transaction monitoring for AML requires real-time classification of blockchain transactions at millions-per-day scale, with false positive rates that must be low enough to avoid flagging legitimate customers and false negative rates that must be low enough to satisfy regulators. This is a challenging multi-objective optimization problem with significant legal consequences for errors in either direction.

---
