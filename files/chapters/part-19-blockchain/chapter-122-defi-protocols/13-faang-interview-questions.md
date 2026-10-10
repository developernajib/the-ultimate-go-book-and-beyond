## 122.13 FAANG Interview Questions

**Q1: Explain how Uniswap v2's constant product formula determines swap output and price impact.**
A: Pools maintain reserves (`x`, `y`) with invariant `x * y = k`. A swap of `dx` input yields `dy = y - k / (x + dx * (1 - fee))`. Price impact scales with `dx / x`, so thin pools produce large slippage on modest trades. Go clients compute expected output and minimum-out (applying slippage tolerance in basis points) before sending the swap.

**Q2: How would you protect a Go arbitrage bot against sandwich attacks?**
A: Submit through a private mempool such as Flashbots to avoid public mempool visibility, set tight minimum-out bounds so front-running becomes unprofitable, include short transaction deadlines, and consider commit-reveal patterns for protocol-level operations. At the transaction level, split large trades across several smaller ones routed through different pools to dilute MEV capture.

**Q3: Why are flash loans atomic, and what guarantees does that provide?**
A: The borrow, arbitrary logic, and repayment all execute inside one transaction. If repayment plus fee is not satisfied when the transaction ends, the EVM reverts every state change, so the lender never loses funds. This makes flash loans uncollateralized: economic safety comes from transaction atomicity rather than posted collateral.

**Q4: How should a Go service consume Chainlink price feeds safely?**
A: Call `latestRoundData`, validate `updatedAt` against a freshness window (typically the feed's heartbeat plus a margin), check `answer > 0`, and compare against a sanity band. Fall back to a secondary feed or halt sensitive operations if validation fails, because stale or manipulated oracle values cause the largest class of DeFi exploits.

**Q5: How do you monitor lending position health across thousands of accounts efficiently?**
A: Maintain an off-chain replica by indexing `Borrow`, `Repay`, `Deposit`, and `Withdraw` events, then periodically batch-poll `getUserAccountData` for accounts near the liquidation threshold only. Subscribe to oracle update events to recompute health factors on price moves and trigger liquidation bots when a position crosses the configured threshold.
