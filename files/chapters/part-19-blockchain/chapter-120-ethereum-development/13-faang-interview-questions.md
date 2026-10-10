## 120.12 FAANG Interview Questions

**Q1: Walk through the lifecycle of an Ethereum transaction submitted from a Go service.**
A: The service fetches the sender's pending nonce, estimates gas via `EstimateGas`, assembles fee parameters (base fee plus a priority tip under EIP-1559), signs the transaction locally with an `ecdsa.PrivateKey`, and broadcasts via `SendTransaction`. It then calls `bind.WaitMined`, inspects the receipt's `Status` field, and only treats the operation as final after a configurable confirmation depth.

**Q2: Why are HTTP RPC endpoints insufficient for an event-driven backend?**
A: HTTP requires polling, which adds latency and wastes RPC quota. WebSocket endpoints support `SubscribeFilterLogs` and `SubscribeNewHead`, so the node pushes events as they are mined. A production design combines WebSocket subscriptions for real-time flow with HTTP `FilterLogs` for historical backfill and gap recovery on reconnect.

**Q3: How do you handle gas estimation safely across volatile network conditions?**
A: Call `EstimateGas` against the current state, then multiply by a safety factor (typically 1.15 to 1.25) because state can change between estimation and inclusion. Under EIP-1559, set `maxFeePerGas` to at least `baseFee + maxPriorityFeePerGas` with enough headroom to survive base-fee spikes, and cap both values to bound worst-case spend.

**Q4: How should private keys be managed in a production Go service?**
A: Keys must never appear as plaintext in logs, configuration, or serialized state. Production systems store keys in encrypted keystores (`go-ethereum/accounts/keystore`), KMS services, or hardware security modules, and the application holds only ephemeral `*ecdsa.PrivateKey` references scoped to the signing operation.

**Q5: How do you distinguish a successful transaction from a mined-but-reverted one?**
A: Waiting for the receipt is not enough, since a reverted transaction is still mined and burns gas. The service must check `receipt.Status == 1`. A status of 0 indicates a revert, in which case the service inspects revert reason strings via a `debug_traceTransaction` or `eth_call` replay to surface the underlying error.

