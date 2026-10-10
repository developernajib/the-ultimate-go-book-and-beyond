# Chapter 120: Ethereum Development with Go (Optional)

*"Ethereum is not just a blockchain - it's a decentralized world computer that executes code exactly as programmed, without any possibility of downtime, censorship, or third-party interference."* - Vitalik Buterin

When the DeFi protocol Compound launched its governance token in June 2020 and accidentally distributed $90 million to users due to a bug in a newly deployed smart contract, the team faced an unprecedented situation: the contract was immutable and the funds were locked by code that ran exactly as written, regardless of intent. When the Ethereum DAO hack in 2016 drained $60 million by exploiting a reentrancy vulnerability, the only recourse was a contentious hard fork that split the Ethereum community permanently. These incidents crystallized a fundamental truth about Ethereum development: code deployed on Ethereum executes with absolute fidelity to its logic, not its intent. There are no support tickets, no rollbacks, no escalations to a sysadmin. The stakes of correctness in Ethereum development are orders of magnitude higher than in conventional backend engineering.

Go-ethereum (Geth) is the reference implementation of the Ethereum protocol, and the `go-ethereum` library is the production standard for backend Ethereum development. Exchanges including Coinbase, Kraken, and Binance use it to monitor the chain and process deposits and withdrawals. DeFi protocols including Uniswap and Aave use Go backends to index events, compute off-chain state, and serve data to their frontends. NFT marketplaces use Go to listen for ERC-721 transfer events and maintain their databases in sync with on-chain state. The library provides complete access to Ethereum's JSON-RPC API, a Go ABI encoder/decoder that handles all Ethereum types, a keystore for managing accounts, and utilities for constructing, signing, and broadcasting transactions with correct gas estimation.

This chapter teaches you to build production Ethereum backends in Go using the same patterns employed at operating exchanges and DeFi protocols. You will connect to mainnet and testnets, query blockchain state, manage accounts and HD wallets, construct and sign transactions with proper EIP-1559 gas pricing, generate type-safe contract bindings with `abigen`, listen to contract events with efficient filtering, and structure a backend service that handles the realities of blockchain: chain reorganizations, failed transactions, RPC node outages, and mempool congestion.

**What you'll learn in this chapter:**
- Ethereum architecture from a backend developer's perspective: accounts, transactions, the EVM, gas, and the state machine model
- Connecting to Ethereum networks with `go-ethereum`: WebSocket vs. HTTP transports, IPC, and handling node failover
- Account and key management: generating accounts, HD wallet derivation with BIP32/BIP44, importing keystores, and secure key handling patterns
- Reading blockchain state: fetching blocks, transactions, receipts, account balances, and contract storage slots
- Sending transactions: ETH transfers, ERC-20 token transfers, EIP-1559 gas pricing, nonce management, and handling mempool replacement
- Generating type-safe contract bindings with `abigen` and interacting with contracts through the generated Go API
- Event listening and filtering: subscribing to real-time events, querying historical logs, and handling chain reorganizations
- Production backend patterns: connection pooling, retry logic, RPC load balancing, and idempotent transaction submission

**Why this matters at scale:**
Coinbase's blockchain infrastructure - processing billions of dollars of on-chain transactions daily across dozens of chains - is built predominantly on Go services using the go-ethereum library for Ethereum interaction. OpenSea, which at its peak processed over $3 billion in monthly NFT trading volume, built its event indexing and state synchronization backend in Go, using the same `FilterLogs` and `SubscribeFilterLogs` patterns covered in this chapter.

**Prerequisites:** Chapter 119 (Blockchain Fundamentals), Chapter 107 (Cryptography in Go), Chapter 60 (Networking), Chapter 11 (Concurrency patterns)

---

### Junior → FAANG: Starting Your Ethereum Development Journey

Ethereum development in Go is dominated by the go-ethereum (Geth) library, which is both the reference client implementation and the primary toolkit for interacting with Ethereum from Go applications. Before writing any Ethereum interaction code, understand that go-ethereum is a large, mature codebase written by protocol engineers: it is not designed for ergonomic application development and you will frequently need to look at the source code to understand what a function actually does rather than relying on documentation alone.

The most important prerequisite gap for junior Go engineers approaching Ethereum development is comfort with big integers. Ethereum amounts (wei) are denominated in units that overflow int64: 1 ETH is 10^18 wei, and the total ETH supply is in the tens of millions, meaning you routinely work with numbers on the order of 10^25. Go's `math/big` package is the only correct tool. Any code that converts Ethereum amounts to float64 for arithmetic introduces precision errors that translate to financial inaccuracies.

For interview preparation, practice explaining the Ethereum client architecture: the JSON-RPC API is the external interface, the execution client (Geth, Erigon, Nethermind, Besu) processes EVM execution and manages state, and the consensus client (Prysm, Lighthouse, Teku) manages proof-of-stake consensus. Post-Merge Ethereum requires both layers running together connected via the Engine API. Interviewers at companies like Coinbase and ConsenSys expect you to know this architecture without being prompted.

First-job habit: always connect to Ethereum through a connection that you can switch without code changes. Use a configuration value for the RPC endpoint, never hardcode it. This allows you to point your application at a local devmode node for development, a testnet for integration testing, and mainnet for production, all through configuration changes rather than code changes.

### Senior @ FAANG: Ethereum Development Platform Ownership

At staff level, Ethereum development is a platform engineering problem: you are not just writing code that talks to Ethereum, you are designing the infrastructure, tooling, and standards that enable dozens of engineers to integrate with Ethereum safely and efficiently. This platform perspective changes every decision, from which libraries to standardize on to how to structure the RPC connection pool to how events propagate through the backend.

The ADR for go-ethereum as the primary library for Ethereum interaction in a Go-based organization should address: the library's version pinning strategy (go-ethereum releases frequently and sometimes with breaking API changes), the dependency on Geth's internal packages (which are not part of the stable API and may change between patch versions), and the alternatives considered (ethclient, ethers.go, and lighter wrapper libraries that may be more ergonomic but sacrifice completeness).

Ethereum development at production scale requires an RPC infrastructure layer that is more sophisticated than a single connection string. The RPC layer must provide: connection pooling (one connection per goroutine is too expensive), automatic failover between providers, request rate limiting to avoid provider-side throttling, request deduplication (two concurrent calls to `eth_getBlockByNumber` for the same block should result in one RPC call), and metrics on RPC call latency and error rates by method. Building this layer correctly is a staff-level infrastructure investment that pays dividends across every team that uses it.

Ethereum development governance at a mature organization includes: a checklist for new smart contract integrations (ABI compatibility verification, event schema registration, gas limit review), a runbook for handling Ethereum hard forks (which EIPs affect the application layer, when to upgrade the go-ethereum dependency, how to test EIP behavior on a local fork of mainnet), and a process for evaluating new go-ethereum releases before upgrading production dependencies.

The post-Merge Ethereum development environment is significantly more complex than pre-Merge: you must understand the Engine API, the separation between execution and consensus clients, the beacon chain APIs for validator-related operations, and the new finality semantics. Staff engineers are responsible for keeping the team's knowledge and tooling current with this evolution, including updating internal documentation and onboarding materials when the Ethereum protocol changes significantly.

Bar-raiser signals: designing an Ethereum indexing system that maintains consistency under chain reorgs (requires tracking block hashes rather than just block numbers, detecting when a previously indexed block is no longer in the canonical chain, and replaying affected events with corrected state), or explaining how EIP-4844 changes the economics of posting rollup data to Ethereum and what infrastructure changes are needed for a rollup operator. These topics reveal genuine depth in Ethereum development.

L6 and L7 engineers participate in the Ethereum ecosystem's governance and evolution: following EIPs as they progress through the proposal, review, and inclusion process, evaluating the impact of proposed changes on their organization's systems months before the changes are scheduled to go live, and in some cases contributing comments or implementations to the EIP process. This level of protocol engagement is a distinguishing characteristic of principal engineers in the Ethereum development ecosystem.

---
