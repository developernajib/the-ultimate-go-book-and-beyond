## 123.15 FAANG Interview Questions

**Q1: Design an RPC provider pool in Go with automatic failover.**
A: Wrap a list of `ethclient.Client` instances behind an interface with per-endpoint latency and error tracking. Route each call to the lowest-latency healthy endpoint, mark endpoints unhealthy on consecutive failures, and periodically re-probe them with lightweight `eth_blockNumber` checks. Fall back across providers on timeouts, enforce per-provider rate limits, and surface metrics for observability.

**Q2: How does a Go indexer correctly handle a chain reorganization?**
A: For each new block, compare its `ParentHash` with the previously indexed block's hash. On mismatch, walk backward until a common ancestor is found, delete or invalidate all indexed state after that ancestor, then re-index the canonical chain from there. Writes must be transactional so partial rollbacks never leave the index in an inconsistent state.

**Q3: Why is Sign-In With Ethereum considered more secure than traditional password login?**
A: SIWE (EIP-4361) relies on the user signing a structured message with their private key, which never leaves the wallet. The backend recovers the signer address from the signature and verifies the nonce and domain, eliminating password databases, credential stuffing risk, and phishing targets. Sessions remain ordinary server-side tokens scoped to the authenticated address.

**Q4: When is The Graph preferable to a custom indexer, and when is it not?**
A: The Graph is preferable when schemas fit standard event-driven aggregation and the target protocol already has a curated subgraph, because it removes operational overhead. Custom Go indexers win when queries require cross-protocol joins, non-event state (balances at arbitrary blocks), sub-second freshness, or workflows that subgraph handlers cannot express in AssemblyScript.

**Q5: Describe a caching strategy for Web3 data that balances freshness and cost.**
A: Cache by mutability class. Finalized block bodies, receipts, and historical logs are immutable after enough confirmations and can be cached indefinitely. Balances, allowances, and nonces are mutable and require TTL-based caching with event-driven invalidation (for example, busting a balance entry on seeing a `Transfer` event involving that address). Always key cache entries by chain ID to avoid cross-chain bleed.
