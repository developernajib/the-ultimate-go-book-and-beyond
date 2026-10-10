# Chapter 123: Web3 Infrastructure (Optional)

> Running your own node is not optional if you want to build infrastructure that survives. Relying on someone else's node is renting your availability from a company that can go down, change its pricing, or block your IP.

Decentralized applications are only as decentralized as their infrastructure. A dApp whose smart contracts live on Ethereum but whose frontend queries a single Infura node, stores metadata on a centralized CDN, and authenticates via a third-party OAuth provider is functionally as centralized as any traditional web application. True Web3 infrastructure means distributing the full stack: blockchain access through a pool of RPC providers with automatic failover, content storage through IPFS where content-addressed files are retrievable from any node holding a copy, on-chain data queries through The Graph's decentralized indexing network rather than expensive archive node calls, and authentication through Sign-In With Ethereum (SIWE) so users prove ownership of their wallet address rather than delegating identity to a platform.

The operational challenges of Web3 infrastructure are distinct from traditional backend engineering. Blockchain reorganizations - reorgs - are a fundamental property of proof-of-work and even proof-of-stake chains: a block that was valid 30 seconds ago may be orphaned as a longer chain wins consensus, invalidating transactions your application already confirmed. Event indexing services must detect reorgs, roll back their state to the fork point, and re-index from the canonical chain. RPC providers have rate limits measured in requests per second and "compute units" that vary by call type - `eth_getLogs` costs far more than `eth_blockNumber` - so connection pooling and intelligent request routing are essential to avoid throttling. These are problems traditional backend engineers have never encountered, and the patterns for solving them correctly are not widely documented.

Go is the dominant language for Web3 infrastructure because `go-ethereum` is the canonical Ethereum client implementation, and the same library powers both the node and application-level client code. The `ethclient` package provides a high-level RPC client, the `accounts/abi` package handles contract ABI encoding, and the node's internal packages expose the same data structures used in production Ethereum clients like Geth. This means Go infrastructure code can be tested against an in-process simulated backend, operated alongside a real Geth node using the same binary dependencies, and trusted to handle edge cases - reorgs, uncle blocks, pending transaction states - in ways that third-party RPC client libraries in other languages often miss.

**What you'll learn in this chapter:**

- Design a multi-provider RPC architecture with connection pooling, per-method routing, automatic failover, and latency-based load balancing across Infura, Alchemy, QuickNode, and self-hosted Geth nodes
- Build event indexing services in Go that handle blockchain reorganizations correctly - detecting fork points, rolling back state, and re-indexing from the canonical chain without data corruption
- Integrate The Graph protocol for efficient indexed queries: writing subgraph schemas, deploying subgraph manifests, and querying GraphQL endpoints from Go with typed response structs
- Implement IPFS integration for decentralized content storage: pinning files via the HTTP API, resolving content-addressed URIs, and building fallback chains when preferred gateways are unavailable
- Build Sign-In With Ethereum (SIWE) authentication in Go - verifying EIP-4361 signed messages, managing session tokens, and integrating with standard Go HTTP middleware
- Implement multi-chain infrastructure that manages connections, contract deployments, and event streams across Ethereum mainnet, Polygon, Arbitrum, and Optimism simultaneously
- Stream blockchain events at scale using WebSocket subscriptions with automatic reconnection, backpressure handling, and dead-letter queues for failed event processing
- Apply Web3-specific caching, rate limiting, and health-check patterns to keep infrastructure costs predictable and availability targets achievable

**Why this matters at scale:**

Alchemy and Infura - the two dominant RPC providers - built their entire platforms in Go because `go-ethereum`'s internals are the authoritative implementation of the Ethereum protocol. OpenSea's NFT indexing infrastructure, which tracks billions of token transfer events across multiple chains, uses The Graph for historical queries and direct Go-based event streaming for real-time updates. Chainlink's oracle node network - thousands of independent Go processes reading off-chain data and submitting it on-chain - is the largest production deployment of Go-based Web3 infrastructure in existence, handling over 100 million data point updates per year. Understanding this infrastructure layer is the prerequisite for building anything at this scale.

**Prerequisites:** Chapter 120 (Ethereum Development with Go), Chapter 121 (Smart Contracts with Go), or Chapter 122 (DeFi Protocols with Go), familiarity with Go HTTP clients, WebSockets, and PostgreSQL, and basic understanding of IPFS content addressing and GraphQL.

---

### Junior → FAANG: Web3 Infrastructure as the Foundation of Blockchain Applications

Web3 infrastructure is the operational layer that makes blockchain applications reliable, scalable, and observable. It includes: the Ethereum nodes that your applications communicate with, the indexing services that make on-chain data queryable, the monitoring systems that detect when things go wrong, and the multi-chain support that allows your application to work across different blockchain networks. Understanding this infrastructure layer is as important as understanding the blockchain protocols themselves.

The most common misconception for junior engineers approaching Web3 infrastructure is that blockchain applications can rely entirely on third-party RPC providers (Infura, Alchemy, Quicknode) without owning any infrastructure. This works for prototype-stage applications but fails at production scale: provider rate limits, downtime, and data freshness constraints all become blockers when your application needs to be available, fast, and accurate. Understanding when to use third-party providers and when to run your own infrastructure is a foundational judgment call.

For interview preparation, be able to describe the full infrastructure stack for a production DApp backend: a load-balanced set of RPC nodes for read traffic, a dedicated node for transaction submission, an event indexer that processes blocks and stores application events in a relational database, a monitoring system that tracks node health and reorg detection, and a multi-provider fallback mechanism for high availability. Each component has specific failure modes and specific Go implementation patterns.

First-job habit: always log the block number and block hash for every significant blockchain read operation. This creates an audit trail that allows you to verify whether a read was on a block that later got reorged, and it makes debugging much faster when you need to reproduce a production issue.

### Senior @ FAANG: Web3 Infrastructure as a Platform Engineering Domain

At staff level, Web3 infrastructure is a platform engineering domain with the same concerns as any critical infrastructure: availability, reliability, scalability, observability, and security. The Web3-specific complications are: the data source (the blockchain) is append-only and eventually consistent, the primary external interface (JSON-RPC) has no official SLA, and the failure modes include reorgs that can invalidate previously processed data.

ADRs for Web3 infrastructure architecture must address: the RPC provider strategy (self-hosted nodes, third-party providers, or hybrid), the indexing strategy (custom indexer, The Graph subgraph, or cloud provider indexing service), the multi-chain support architecture (single unified interface or protocol-specific adapters), and the disaster recovery model (what is the RTO and RPO for each critical blockchain data stream?).

Web3 infrastructure reliability engineering differs from traditional reliability engineering in one critical way: the source of truth (the blockchain) is itself eventually consistent and subject to reorgs. An infrastructure with 99.99 percent uptime that processes events incorrectly during reorgs is not reliable in the Web3 sense. Reliability must be defined in terms of correctness (do the stored events match the canonical chain?) as well as availability (is the service responding?).

Staff engineers who own Web3 infrastructure are responsible for the relationship with blockchain protocol teams (understanding upcoming protocol upgrades and their infrastructure implications), with node client teams (tracking client-level bugs and performance improvements), and with data provider teams (evaluating new provider features and negotiating appropriate SLAs). These external relationships are a primary source of advance warning for infrastructure changes that require preparation.

The regulatory dimension of Web3 infrastructure is growing: sanctions screening for RPC requests (should you serve RPC requests from sanctioned IP addresses?), transaction monitoring for AML (should your RPC node report transactions from certain addresses to compliance systems?), and data retention for regulatory reporting (how long must you retain blockchain event data?) all require infrastructure decisions that have legal implications. Staff engineers who own Web3 infrastructure must engage with legal and compliance teams to understand these requirements.

Bar-raiser signals: designing a Web3 infrastructure deployment that achieves 99.9 percent availability for RPC service without any third-party provider dependency (requiring geographically distributed nodes, health-based routing, and automated failover), or explaining how the Portal Network changes the infrastructure requirements for Web3 applications (by enabling stateless clients that can verify state proofs without running a full node, which reduces the infrastructure cost of maintaining historical state access). These forward-looking infrastructure topics reveal principal-level platform thinking.

---
