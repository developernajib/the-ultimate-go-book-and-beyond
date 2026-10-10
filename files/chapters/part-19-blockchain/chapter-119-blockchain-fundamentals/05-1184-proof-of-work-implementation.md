## 119.4 Proof of Work Implementation

Proof of Work (PoW) is the consensus mechanism that makes blockchains secure. Miners compete to find a nonce that produces a hash meeting difficulty requirements.

### 4.1 Mining Algorithm

The mining loop increments a nonce and re-hashes the block header until the resulting hash is numerically less than the target derived from the difficulty, a computationally expensive search with a cheap verification step. Encoding the target as a `*big.Int` allows direct integer comparison rather than string prefix matching, which is both faster and more correct for boundary conditions.

```go
// proof_of_work.go
package blockchain

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"math"
	"math/big"
	"strconv"
)

const targetBits = 16 // Difficulty: number of leading zeros required

// ProofOfWork represents proof-of-work
type ProofOfWork struct {
	block  *Block
	target *big.Int
}

// NewProofOfWork creates a new proof-of-work for a block
func NewProofOfWork(block *Block) *ProofOfWork {
	target := big.NewInt(1)
	target.Lsh(target, uint(256-targetBits)) // Left shift to create target

	pow := &ProofOfWork{
		block:  block,
		target: target,
	}

	return pow
}

// prepareData combines block data for hashing
func (pow *ProofOfWork) prepareData(nonce int) []byte {
	data := bytes.Join(
		[][]byte{
			pow.block.PrevBlockHash,
			pow.block.HashTransactions(),
			[]byte(strconv.FormatInt(pow.block.Timestamp, 10)),
			[]byte(strconv.Itoa(targetBits)),
			[]byte(strconv.Itoa(nonce)),
		},
		[]byte{},
	)

	return data
}

// Run performs proof-of-work (mining)
func (pow *ProofOfWork) Run() (int, []byte) {
	var hashInt big.Int
	var hash [32]byte
	nonce := 0

	fmt.Printf("Mining block...\n")

	for nonce < math.MaxInt64 {
		data := pow.prepareData(nonce)
		hash = sha256.Sum256(data)
		hashInt.SetBytes(hash[:])

		// Check if hash is less than target
		if hashInt.Cmp(pow.target) == -1 {
			fmt.Printf("Found nonce: %d\n", nonce)
			break
		} else {
			nonce++
		}

		// Progress indicator
		if nonce%100000 == 0 {
			fmt.Printf(".")
		}
	}
	fmt.Printf("\n")

	return nonce, hash[:]
}

// Validate validates the proof-of-work
func (pow *ProofOfWork) Validate() bool {
	var hashInt big.Int

	data := pow.prepareData(pow.block.Nonce)
	hash := sha256.Sum256(data)
	hashInt.SetBytes(hash[:])

	return hashInt.Cmp(pow.target) == -1
}

// CalculateDifficulty calculates current network difficulty
func CalculateDifficulty(targetBits int) *big.Int {
	difficulty := big.NewInt(1)
	difficulty.Lsh(difficulty, 256)

	target := big.NewInt(1)
	target.Lsh(target, uint(256-targetBits))

	difficulty.Div(difficulty, target)

	return difficulty
}

// EstimateHashRate estimates hash rate based on mining time
func EstimateHashRate(nonce int, durationSeconds float64) float64 {
	return float64(nonce) / durationSeconds
}
```

### 4.2 Difficulty Adjustment

In production blockchains like Bitcoin, difficulty adjusts every 2016 blocks to maintain ~10 minute block times.

```go
// difficulty.go
package blockchain

import (
	"time"
)

const (
	targetBlockTime       = 60 * time.Second // Target 1 minute per block
	difficultyAdjustEvery = 10               // Adjust every 10 blocks
)

// AdjustDifficulty adjusts difficulty based on actual mining time
func (bc *Blockchain) AdjustDifficulty() int {
	bc.mu.RLock()
	defer bc.mu.RUnlock()

	if len(bc.blocks) < difficultyAdjustEvery {
		return targetBits
	}

	// Get last adjustment period
	currentBlock := bc.blocks[len(bc.blocks)-1]
	previousBlock := bc.blocks[len(bc.blocks)-difficultyAdjustEvery]

	actualTime := time.Unix(currentBlock.Timestamp, 0).Sub(
		time.Unix(previousBlock.Timestamp, 0))
	expectedTime := targetBlockTime * difficultyAdjustEvery

	// Calculate new difficulty
	ratio := float64(actualTime) / float64(expectedTime)

	newBits := targetBits
	if ratio < 0.5 {
		// Blocks too fast, increase difficulty
		newBits += 1
	} else if ratio > 2.0 {
		// Blocks too slow, decrease difficulty
		newBits -= 1
	}

	// Clamp between reasonable bounds
	if newBits < 8 {
		newBits = 8
	}
	if newBits > 32 {
		newBits = 32
	}

	return newBits
}
```

---

### Junior → FAANG: Understanding Proof of Work Before It Disappears from Interviews

Proof of Work is no longer used by Ethereum (which moved to Proof of Stake in September 2022) but the conceptual model it provides for understanding Nakamoto consensus, difficulty adjustment, and probabilistic finality is still tested heavily in blockchain system design interviews. Interviewers use PoW as a clean starting point before asking you to contrast it with PoS or BFT consensus.

The implementation exercise is revealing: the core loop is a nonce increment followed by a hash comparison, but the real learning is in the difficulty encoding. Bitcoin encodes difficulty as a target value (the hash must be numerically less than the target), and the target is adjusted every 2016 blocks. Implementing this correctly requires understanding big integer comparison, not just string prefix matching. Go's `math/big` package is the right tool.

For interview preparation, understand the 51 percent attack model: an attacker who controls more than half of the total hash rate can privately mine a longer chain and then release it, orphaning honest miners' blocks and enabling double-spend. Be able to explain why this is economically expensive but not cryptographically impossible, and how confirmation depth (waiting for N blocks) mitigates the risk as a function of the attacker's hash rate fraction.

A first-job habit from this topic: when working on any system that acts on blockchain events (deposits, transfers, settlements), always confirm with the business team what confirmation depth is required, document it as a configuration value, and make the default conservative. Undercounting confirmations leads to double-spend exposure. Overcounting leads to user experience complaints. Both have business consequences.

### Senior @ FAANG: PoW as a Lens for Evaluating Consensus Security Models

Although Proof of Work is operationally irrelevant for Ethereum in 2025, it remains the cleanest model for reasoning about the security assumptions underlying Nakamoto-style consensus. Staff engineers use PoW intuition to evaluate the security of newer consensus mechanisms by asking: what is the analogous "work" in this system, who controls it, what is the cost of acquiring a majority, and what can a majority attacker do?

In Proof of Stake, the "work" is stake (ETH in Ethereum's case), and a majority attacker needs to accumulate more than one-third of staked ETH to disrupt liveness or more than two-thirds to finalize an invalid block (these thresholds differ because Ethereum's Gasper protocol uses BFT-style finality for the checkpoint layer). The economic cost of this attack is bounded by the market cap of the staked asset and is further deterred by slashing: provable misbehavior causes a validator to lose a portion of their staked ETH. Mapping the PoW security intuition onto this model is a staff-level analytical skill.

Difficulty adjustment algorithms represent a subtle but important attack surface. The 2020 attack on Ethereum Classic used a combination of rented hash power and a predictable difficulty adjustment to execute a deep reorg. The attack succeeded partly because the difficulty algorithm allowed hash rate to be added and removed faster than the adjustment could respond. Any custom PoW chain that a team builds or maintains must have a formally specified difficulty adjustment algorithm with attack scenario analysis documented before launch.

ADRs for systems that depend on PoW chains (Bitcoin, Litecoin, etc.) must specify the confirmation depth policy and the business logic that handles edge cases: what happens if a transaction that was considered confirmed is orphaned in a reorg? What is the maximum reorg depth the system's state machine can handle correctly? These questions have real financial consequences when the answers are wrong.

The energy consumption critique of Proof of Work led to regulatory pressure in several jurisdictions, including proposed PoW mining bans in New York state and carbon reporting requirements under various ESG frameworks. For companies running PoW mining operations or building software for them, staff engineers may be asked to contribute to ESG reporting data collection systems. Understanding the computational and therefore energy profile of your PoW system is an input to that reporting.

Bar-raiser interview signals: designing a mining pool payout system that is fair under different hash rate distributions (proportional, Pay Per Share, Pay Per Last N Shares), explaining the variance reduction properties of different payout schemes, or describing the selfish mining attack and why it can make mining profitable even with less than 50 percent of hash rate. These topics go beyond tutorial-level PoW knowledge and test genuine depth.

L6 thinking on PoW: if your organization needs to support a Bitcoin-family chain that uses Proof of Work, the operational concerns are fundamentally different from Proof of Stake. PoW chains have no slashing, no validator set management, and no governance votes. Their "governance" is expressed through node software adoption (UASF) or hash power signaling. Understanding this governance model is essential for anticipating hard forks and managing software upgrades on infrastructure that processes real economic value.

---
