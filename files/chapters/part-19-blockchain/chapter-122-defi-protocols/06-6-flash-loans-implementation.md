## 122.6 Flash Loans Implementation

Flash loans allow borrowing without collateral, as long as the loan is repaid in the same transaction.

### Flash Loan Executor

The flash loan executor triggers the Aave `flashLoanSimple` call with the receiver contract address and the desired borrow amount. The pool transfers the funds to the receiver, calls `executeOperation` on it, and expects full repayment plus a 0.05% fee returned before the transaction ends. The Go code orchestrates this call and monitors the resulting event logs to confirm repayment and calculate net profit.

```go
// pkg/defi/flashloan/executor.go
package flashloan

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"yourapp/pkg/defi"
)

// Executor handles flash loan execution
type Executor struct {
	client     *ethclient.Client
	pool       common.Address
	receiver   common.Address // Flash loan receiver contract
	transactor *bind.TransactOpts
}

// NewExecutor creates a flash loan executor
func NewExecutor(client *ethclient.Client, pool, receiver common.Address, transactor *bind.TransactOpts) *Executor {
	return &Executor{
		client:     client,
		pool:       pool,
		receiver:   receiver,
		transactor: transactor,
	}
}

// ExecuteFlashLoan executes a flash loan
func (e *Executor) ExecuteFlashLoan(ctx context.Context, req *defi.FlashLoanRequest) (*types.Transaction, error) {
	pool, err := NewIPoolFlashLoan(e.pool, e.client)
	if err != nil {
		return nil, fmt.Errorf("load pool: %w", err)
	}

	opts := *e.transactor
	opts.Context = ctx

	// Execute flash loan
	tx, err := pool.FlashLoan(
		&opts,
		e.receiver,
		req.Assets,
		req.Amounts,
		req.Modes,
		req.OnBehalfOf,
		req.Params,
		0, // referralCode
	)
	if err != nil {
		return nil, fmt.Errorf("flash loan: %w", err)
	}

	return tx, nil
}

// CalculateFlashLoanFee calculates the fee for a flash loan
func (e *Executor) CalculateFlashLoanFee(amount *big.Int) *big.Int {
	// Aave V3 flash loan fee is 0.09% (9 bps)
	fee := new(big.Int).Mul(amount, big.NewInt(9))
	fee = new(big.Int).Div(fee, big.NewInt(10000))
	return fee
}

// EstimateProfit estimates profit from an arbitrage flash loan
func EstimateProfit(
	borrowAmount *big.Int,
	buyPrice *big.Int,
	sellPrice *big.Int,
	flashLoanFee *big.Int,
) *big.Int {
	// Buy tokens at buyPrice
	tokensReceived := new(big.Int).Div(borrowAmount, buyPrice)

	// Sell tokens at sellPrice
	proceeds := new(big.Int).Mul(tokensReceived, sellPrice)

	// Subtract flash loan repayment (principal + fee)
	repayment := new(big.Int).Add(borrowAmount, flashLoanFee)
	profit := new(big.Int).Sub(proceeds, repayment)

	return profit
}
```

### Flash Loan Receiver Contract (Solidity Reference)

The Solidity receiver implements `executeOperation`, the callback that Aave invokes with the borrowed funds, where the arbitrage logic runs and the repayment approval is granted before returning. If the receiver does not approve the pool to pull back `amount + premium` before returning, the entire transaction reverts and the flash loan is never funded.

```go
// This is a reference implementation in Solidity that would be deployed
// and called by the Go code above

/*
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FlashLoanReceiver {
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;

    constructor(address provider) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(provider);
        POOL = IPool(IPoolAddressesProvider(provider).getPool());
    }

    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "Caller must be pool");

        // Decode custom params
        (address targetDEX, bytes memory swapData) = abi.decode(params, (address, bytes));

        // Execute arbitrage logic
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 amountOwing = amounts[i] + premiums[i];

            // Your arbitrage logic here
            // 1. Swap on DEX A
            // 2. Swap on DEX B
            // 3. Ensure profit > premium

            // Approve pool to pull funds
            IERC20(assets[i]).approve(address(POOL), amountOwing);
        }

        return true;
    }

    function requestFlashLoan(
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external {
        uint256[] memory modes = new uint256[](assets.length);
        // modes = 0 for flash loan (no debt)

        POOL.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0
        );
    }
}
*/
```

### Arbitrage Bot Example

An arbitrage bot watches prices across venues and, on divergence, borrows via flash loan, executes both legs, repays, and keeps the spread, all atomically within one transaction so a failed leg reverts everything.

```go
// pkg/defi/arbitrage/bot.go
package arbitrage

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"yourapp/pkg/defi"
	"yourapp/pkg/defi/flashloan"
	"yourapp/pkg/defi/uniswap"
)

// Bot executes arbitrage opportunities using flash loans
type Bot struct {
	flashLoan *flashloan.Executor
	dexA      *uniswap.Client
	dexB      *uniswap.Client

	minProfit *big.Int
	gasPrice  *big.Int
}

// NewBot creates an arbitrage bot
func NewBot(
	flashLoan *flashloan.Executor,
	dexA, dexB *uniswap.Client,
	minProfit *big.Int,
) *Bot {
	return &Bot{
		flashLoan: flashLoan,
		dexA:      dexA,
		dexB:      dexB,
		minProfit: minProfit,
	}
}

// FindOpportunity searches for arbitrage opportunities
func (b *Bot) FindOpportunity(ctx context.Context, tokenA, tokenB common.Address, amount *big.Int) (*Opportunity, error) {
	// Get quote from DEX A
	quoteA, err := b.dexA.GetQuote(ctx, amount, tokenA, tokenB)
	if err != nil {
		return nil, fmt.Errorf("get quote A: %w", err)
	}

	// Get quote from DEX B
	quoteB, err := b.dexB.GetQuote(ctx, amount, tokenA, tokenB)
	if err != nil {
		return nil, fmt.Errorf("get quote B: %w", err)
	}

	// Calculate flash loan fee
	flashLoanFee := b.flashLoan.CalculateFlashLoanFee(amount)

	// Check if buying on A and selling on B is profitable
	profitAtoB := flashloan.EstimateProfit(
		amount,
		quoteA.AmountOut,
		quoteB.AmountOut,
		flashLoanFee,
	)

	if profitAtoB.Cmp(b.minProfit) > 0 {
		return &Opportunity{
			BuyDEX:    "DEX_A",
			SellDEX:   "DEX_B",
			TokenIn:   tokenA,
			TokenOut:  tokenB,
			Amount:    amount,
			Profit:    profitAtoB,
			Timestamp: time.Now(),
		}, nil
	}

	// Check reverse direction
	profitBtoA := flashloan.EstimateProfit(
		amount,
		quoteB.AmountOut,
		quoteA.AmountOut,
		flashLoanFee,
	)

	if profitBtoA.Cmp(b.minProfit) > 0 {
		return &Opportunity{
			BuyDEX:    "DEX_B",
			SellDEX:   "DEX_A",
			TokenIn:   tokenA,
			TokenOut:  tokenB,
			Amount:    amount,
			Profit:    profitBtoA,
			Timestamp: time.Now(),
		}, nil
	}

	return nil, fmt.Errorf("no profitable opportunity found")
}

// Execute executes an arbitrage opportunity
func (b *Bot) Execute(ctx context.Context, opp *Opportunity) error {
	fmt.Printf("Executing arbitrage: Buy on %s, Sell on %s, Profit: %s\n",
		opp.BuyDEX, opp.SellDEX, opp.Profit.String())

	// Prepare flash loan parameters
	assets := []common.Address{opp.TokenIn}
	amounts := []*big.Int{opp.Amount}
	modes := []*big.Int{big.NewInt(0)} // No debt

	// Encode swap parameters
	params := encodeSwapParams(opp)

	req := &defi.FlashLoanRequest{
		Assets:     assets,
		Amounts:    amounts,
		Modes:      modes,
		Params:     params,
		OnBehalfOf: common.Address{}, // Set to receiver contract
	}

	tx, err := b.flashLoan.ExecuteFlashLoan(ctx, req)
	if err != nil {
		return fmt.Errorf("execute flash loan: %w", err)
	}

	fmt.Printf("Flash loan executed: %s\n", tx.Hash().Hex())
	return nil
}

// Opportunity represents an arbitrage opportunity
type Opportunity struct {
	BuyDEX    string
	SellDEX   string
	TokenIn   common.Address
	TokenOut  common.Address
	Amount    *big.Int
	Profit    *big.Int
	Timestamp time.Time
}

// encodeSwapParams encodes parameters for the flash loan receiver
func encodeSwapParams(opp *Opportunity) []byte {
	// Encode swap instructions for the receiver contract
	// This would use ABI encoding in practice
	return []byte{}
}
```

### Junior → FAANG: Flash Loans as a Capital Efficiency Tool

Flash loans are uncollateralized loans that must be borrowed and repaid within the same Ethereum transaction. They are not a magic money-printing mechanism: they are a capital efficiency tool that enables operations that would otherwise require significant upfront capital. Legitimate use cases include arbitrage (buy asset cheap on one DEX, sell expensive on another), collateral swaps (change the collateral type of a borrow position without closing the position), and self-liquidations (liquidate your own undercollateralized position before a bot does it at a worse price for you).

The Aave V3 flash loan interface requires implementing a receiver contract (in Solidity) that receives the borrowed assets and must return them plus the flash loan fee (currently 0.05 percent on Aave V3) by the end of the same transaction. The Go integration for flash loans is therefore about constructing and executing the transaction that calls the Aave Pool's `flashLoan` function with the receiver contract's address and the desired asset and amount. The receiver contract must be deployed separately.

The flash loan fee calculation is a practical concern: if you borrow 1,000,000 USDC via a flash loan at 0.05 percent fee, you must return 1,000,500 USDC. If your arbitrage or other operation does not generate at least 500 USDC of profit before accounting for gas costs, the flash loan is not profitable. In practice, flash loan arbitrage requires very precise profit calculation (accounting for price impact, swap fees, gas costs, and the flash loan fee) before execution.

Interview entry point: explain why flash loans are not a security risk to the protocol that offers them (Aave, Balancer, dYdX). The key is atomicity: if the borrower does not return the full amount plus fees before the transaction ends, the entire transaction reverts, including the initial transfer of the borrowed assets. The protocol is always made whole. Flash loans are a risk to other protocols that do not account for the possibility that a user can temporarily have access to large amounts of capital within a single transaction.

### Senior @ FAANG: Flash Loan Architecture and MEV Integration

At staff level, flash loans are both a capital efficiency tool for legitimate use cases and the primary amplification mechanism for DeFi exploits. Every DeFi protocol integration must be designed with the assumption that users have access to unlimited flash loan capital, and the security model must hold even when an adversary can execute any on-chain operation with billions of dollars of borrowed capital.

Flash loan executor architecture in Go requires careful transaction construction: the `calldata` for the Aave `flashLoan` call includes the receiver contract address and the encoded parameters that will be passed to the receiver's `executeOperation` function. In practice, the receiver contract is a small Solidity contract that decodes these parameters and calls the arbitrage logic (which may itself involve multiple DEX swaps, collateral operations, or other contract interactions). The Go code constructs and submits the outer transaction. The on-chain execution logic lives in the receiver contract.

Flash loan arbitrage is a competitive market dominated by MEV searchers who run sophisticated bots that monitor the mempool for profitable opportunities. Building a competitive flash loan arbitrage system in Go requires: real-time price feed monitoring across multiple DEXes, profit simulation using `eth_call` before submission (to verify profitability and avoid wasted gas on losing transactions), private mempool submission via Flashbots bundles (to prevent front-running of profitable arbitrage transactions), and continuous strategy optimization as competitors adapt.

Flash loans as a governance attack vector deserve specific attention in system design. The Beanstalk governance attack (April 2022) used a flash loan to acquire temporary voting majority and pass a malicious governance proposal in a single transaction. Any governance system that counts token balances at the moment of the vote (rather than at a snapshot taken before the proposal) is vulnerable to this attack. Staff engineers who design or integrate with governance systems must verify the snapshot mechanism and advocate for time-locked governance with appropriate snapshot timing.

Flash loan fee tiering is a business model consideration for protocols that offer flash loans. Aave's 0.05 percent fee generates significant revenue from the large volume of flash loan activity. Alternative fee structures (flat fee per loan, fee waived for protocol-owned callers) have different implications for the type of activity the protocol attracts. Staff engineers who design flash loan functionality into a custom protocol must model the fee economics carefully.

Bar-raiser signals: designing a flash loan arbitrage system that uses Flashbots bundles to guarantee that the arbitrage transaction and a block builder tip transaction are included in the same block (preventing competitors from observing and front-running the profitable opportunity), or explaining the "zero value flash loan" vulnerability where a protocol's flash loan protection mechanism (checking that the borrowed amount was returned) can be bypassed by borrowing 0 tokens and still executing the loan's callback. These edge cases reveal deep flash loan mechanics knowledge.

---
