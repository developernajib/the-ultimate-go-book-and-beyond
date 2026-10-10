## Exercises

1. **Multi-Protocol Yield Optimizer**: Implement a Go service that compares lending APYs between Aave V3 and Compound V3, models gas switching costs, and automatically rebalances supplied capital to maximize yield when the net APY spread exceeds a configured threshold. Include integration tests on an Anvil mainnet fork. Expected outcome: a fully tested rebalancing daemon with configurable rebalance thresholds, gas ceiling, and transaction receipt verification.

2. **Flash Loan Arbitrage Detector and Simulator**: Build a Go service that monitors Uniswap V2 and Sushiswap pair reserves via WebSocket, detects cross-DEX price discrepancies exceeding the 0.09% Aave flash loan fee plus gas costs, constructs the calldata for a flash loan receiver contract, and simulates the transaction via `eth_call`. Expected outcome: an arbitrage detection pipeline that finds profitable cycles and simulates trade execution in under 200ms.

3. **Automated Aave Liquidation Bot**: Write a Go liquidation engine that monitors account health factors across an indexed set of borrowers. When a borrower's health factor drops below 1.0, the bot identifies the highest-value debt and collateral asset pair, calculates the optimal debt amount to cover, and calls `liquidationCall` on the Aave Pool contract. Expected outcome: a liquidation daemon with health factor tracking, slippage protection on seized collateral, and mempool priority gas management.

4. **TWAP Price Oracle and Staleness Sentinel**: Implement a Go client for Uniswap V3 time-weighted average price (TWAP) calculation that queries `observe` on a Uniswap V3 pool across configurable time windows (e.g., 30-minute harmonic mean). Compare the computed TWAP against a Chainlink price feed and raise an alert if deviation exceeds 2%. Expected outcome: a manipulation-resistant price oracle service that detects off-peg conditions and stale rounds.

5. **Multi-Protocol DeFi Portfolio Tracker**: Create a Go backend service that accepts a user address, queries balances and positions across Uniswap LP tokens, Aave collateral/debt, and ERC-20 tokens, computes total net worth and impermanent loss in USD, and streams real-time updates via SSE (Server-Sent Events) or WebSockets. Expected outcome: a unified DeFi position tracker with asynchronous protocol querying, caching, and health factor alerting.

### Junior → FAANG: DeFi Exercises as Competency Validator

The exercises in this DeFi chapter represent realistic production assignments at decentralized trading desks and protocol engineering teams. If you cannot complete the core exercises (fetching quotes, computing slippage bounds, validating oracle staleness, and simulating transactions), you are not yet prepared for technical screens at DeFi-focused companies. If you can complete the advanced exercises (flash loan orchestration, automated liquidations, and cross-protocol yield rebalancing), you will stand out in any senior blockchain engineering interview.

Timing yourself on these exercises provides an honest benchmark: a candidate ready for a production DeFi role should be able to implement an AMM quote calculator with basis-point slippage in under 30 minutes, and a working Chainlink price sentinel with freshness checks in under an hour. When an exercise takes significantly longer, the cause is typically unfamiliarity with BigInt fixed-point arithmetic or EVM gas estimation subtleties.

Publishing your exercise implementations to GitHub with detailed architectural documentation, test coverage against an Anvil mainnet fork, and automated CI pipelines is the most direct way to prove capability to hiring managers. Reviewers look for: non-trivial error handling, private mempool awareness, realistic gas fee parameters, and comprehensive unit and integration tests.

### Senior @ FAANG: DeFi Exercises as Team Engineering Infrastructure

At staff level, these DeFi exercises serve as standard onboarding modules and technical assessment frameworks for incoming platform engineers. Converting these exercises into self-paced learning paths with automated CI evaluation (forked anvil simulations, linting with `golangci-lint`, and fuzzing tests for invariant validation) transforms team onboarding into a repeatable, high-signal process.

Maintaining exercise infrastructure requires continuous updates as protocols upgrade: transitioning from Aave V2 to V3, incorporating Uniswap V4 hook patterns, accounting for EIP-4844 blob-carrying transactions, and verifying compatibility with Go toolchain releases. Staff engineers ensure that the reference implementations adhere to enterprise safety standards: circuit breakers, exposure caps, and time-locked emergency pauses.

In technical hiring, these exercises provide the foundation for take-home coding evaluations. The most revealing take-home tests are not those with convoluted requirements, but those that evaluate an engineer's defensive instincts: how they handle stale oracle data, whether they guard against sandwich attacks, how they structure BigInt calculations to prevent precision loss, and how cleanly they abstract protocol-specific interfaces.
