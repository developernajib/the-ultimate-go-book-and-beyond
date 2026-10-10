## 119.7 Consensus Mechanisms Overview

### 7.1 Proof of Work (PoW)

**Used by**: Bitcoin, Ethereum (pre-Merge), Litecoin

**How it works**: Miners compete to find a nonce that produces a hash below target difficulty.

**Pros**:
- Battle-tested security
- True decentralization
- 51% attack requires massive resources

**Cons**:
- Energy intensive
- Slow finality
- Limited throughput (~7 TPS for Bitcoin)

### 7.2 Proof of Stake (PoS)

**Used by**: Ethereum 2.0, Cardano, Polkadot

**How it works**: Validators stake tokens to participate in consensus. Selected validators propose and validate blocks based on stake amount.

```go
// pos.go
package blockchain

import (
	"crypto/rand"
	"math/big"
)

// Validator represents a PoS validator
type Validator struct {
	Address string
	Stake   int
	Active  bool
}

// ValidatorSet manages validators
type ValidatorSet struct {
	validators []*Validator
}

// SelectValidator selects validator weighted by stake
func (vs *ValidatorSet) SelectValidator() *Validator {
	totalStake := 0
	for _, v := range vs.validators {
		if v.Active {
			totalStake += v.Stake
		}
	}

	// Generate random number
	n, _ := rand.Int(rand.Reader, big.NewInt(int64(totalStake)))
	selection := int(n.Int64())

	// Select based on stake weight
	cumulative := 0
	for _, v := range vs.validators {
		if v.Active {
			cumulative += v.Stake
			if selection < cumulative {
				return v
			}
		}
	}

	return vs.validators[0] // Fallback
}

// AddValidator adds a new validator
func (vs *ValidatorSet) AddValidator(address string, stake int) {
	validator := &Validator{
		Address: address,
		Stake:   stake,
		Active:  true,
	}
	vs.validators = append(vs.validators, validator)
}

// Slash penalizes malicious validator
func (vs *ValidatorSet) Slash(address string, amount int) {
	for _, v := range vs.validators {
		if v.Address == address {
			v.Stake -= amount
			if v.Stake <= 0 {
				v.Active = false
			}
			break
		}
	}
}
```

**Pros**:
- Energy efficient (99.95% less than PoW)
- Higher throughput
- Lower barriers to participation

**Cons**:
- "Nothing at stake" problem
- Requires slashing mechanisms
- Potential centralization (rich get richer)

### 7.3 Practical Byzantine Fault Tolerance (PBFT)

**Used by**: Hyperledger Fabric, Zilliqa

**How it works**: Nodes go through rounds of voting (pre-prepare, prepare, commit) to reach consensus.

**Pros**:
- Fast finality
- High throughput
- No mining required

**Cons**:
- Limited scalability (~100 nodes)
- Requires known validator set
- Communication overhead O(n²)

### 7.4 Delegated Proof of Stake (DPoS)

**Used by**: EOS, Tron, Cosmos

**How it works**: Token holders vote for delegates who produce blocks.

**Pros**:
- Very high throughput
- Fast block times
- Democratic participation

**Cons**:
- More centralized (fewer validators)
- Cartel formation risk
- Voter apathy

---

### Junior → FAANG: Consensus Mechanisms as Interview Currency

Consensus mechanisms are among the most frequently tested topics in blockchain engineering interviews because they sit at the intersection of distributed systems theory and practical blockchain design. The classic result that a junior must know cold is the FLP impossibility theorem: no deterministic protocol can guarantee consensus in an asynchronous network if even one participant can fail. Real blockchain systems work around this by making timing assumptions (partially synchronous models) or by using probabilistic termination (Nakamoto consensus).

The three mechanisms you need to be able to compare at any interview are: Proof of Work (Nakamoto consensus, probabilistic finality, used by Bitcoin), Proof of Stake BFT-style (Tendermint/Cosmos, deterministic finality, bounded validator set), and Ethereum's Gasper (combines LMD-GHOST fork choice with Casper FFG checkpoint finality). For each, know the finality model, the economic security assumption, and the failure mode when the assumption is violated.

A worked comparison exercise: draw the "fork" scenario for each mechanism. In PoW, a fork is resolved by the chain with the most cumulative work winning. In Tendermint, a fork cannot occur without more than one-third of stake being slashable. In Gasper, a fork is possible on the short time scale (before finality) but the checkpoint finality prevents deep reorgs once two-thirds of validators attest to a checkpoint. Being able to draw this comparison is a strong signal in a senior engineer's interview at any blockchain company.

First-job habit: when joining a team that runs validators, immediately read the slashing conditions for the chain you are running. Ethereum slashing conditions are double voting (attesting to two different blocks in the same slot) and surround voting (wrapping a prior attestation). Understand the client-level protections (slashing protection database) and know the procedure for checking that the protection database is intact before starting a validator that has been offline.

### Senior @ FAANG: Consensus Mechanism Selection and Governance

At staff level, consensus mechanism selection is a one-way architectural door. Changing the consensus mechanism of a live chain is a hard fork of the highest difficulty, requiring protocol-level changes and coordinated upgrade of all validators. For new chains being designed for internal use or as application-specific chains on Cosmos, the choice of consensus mechanism is a founding architectural decision that must be documented with full trade-off analysis in an ADR before any code is written.

The key dimensions of a consensus mechanism ADR for a new chain are: finality model (how quickly is a transaction irreversible, and what is the cost of a reorg?), validator set size and governance (how are validators admitted and removed?), economic security budget (how much stake or hash power protects the chain, and what is the cost of an attack?), liveness assumptions (how many validators can be offline before the chain halts?), and throughput and latency (what are the TPS and block time characteristics?).

Cosmos SDK with Tendermint consensus has become the default choice for permissioned and application-specific chains in the FAANG-adjacent blockchain ecosystem, largely because Tendermint's deterministic finality simplifies downstream system design. With deterministic finality, a system can act on a transaction after one block confirmation with no reorg exposure. This simplification has real engineering value: it eliminates the need for confirmation-depth tracking, reorg handling logic, and associated state management in every system that consumes chain events.

The move to Proof of Stake on Ethereum introduced validator economics as an operational concern. Validators earn attestation rewards and block proposal rewards, and lose rewards or stake to slashing for misbehavior. Staff engineers at companies that run Ethereum validators must understand the reward and penalty calculation to model expected returns, set alerting thresholds for reward rate anomalies, and report validator performance accurately to stakeholders.

Liquid staking (Lido, Rocket Pool, Coinbase cbETH) has created a new layer of systemic risk in the Ethereum ecosystem: if a single liquid staking provider controls more than one-third of staked ETH, it can threaten liveness finality. Staff engineers at companies that provide or integrate liquid staking must track validator concentration metrics and contribute to governance discussions about concentration limits. This is an example of protocol-level governance participation that is expected at the L6 and above level.

Bar-raiser signals: explaining the weak subjectivity assumption in Proof of Stake (a new node or a node returning after a long offline period cannot determine the canonical chain from genesis without a trusted recent checkpoint, unlike PoW which can always verify from genesis), or designing a monitoring system that detects validator performance degradation before it reaches slashing risk. These topics test operational and theoretical depth simultaneously.

At the L7 level, consensus mechanism governance extends to cross-chain interoperability. The IBC (Inter-Blockchain Communication) protocol in the Cosmos ecosystem assumes BFT finality on both connected chains. Bridging between a BFT chain and a probabilistic finality chain (e.g., Ethereum mainnet before Merge) required a light client that understood the finality model of the source chain and applied appropriate confirmation delays. Staff engineers designing cross-chain bridges must encode the finality assumptions of each connected chain into the bridge's trust model and document them explicitly.

---
