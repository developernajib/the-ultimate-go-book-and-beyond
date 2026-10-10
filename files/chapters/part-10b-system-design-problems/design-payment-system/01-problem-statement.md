## Problem Statement

A payment system occupies a unique position in system design: it is one of the few systems where a bug can directly cost money in a way that is immediately measurable. Floating-point rounding errors accumulate across millions of transactions. Network timeouts create ambiguity about whether a charge succeeded. Race conditions in balance updates can produce negative balances or double-credits. Every failure mode must be anticipated and handled explicitly.

Design a payment processing system (like Stripe/PayPal) supporting:
- Process 100M transactions per day (1,160/sec average, 5K/sec peak)
- Exactly-once payment semantics (no double charges)
- Multi-currency support (150+ currencies)
- Payment methods: credit cards, bank transfers, digital wallets
- Fraud detection in real-time (< 100ms)
- PCI DSS compliance (never store raw card data)
- Reconciliation and settlement
- Refunds, disputes, chargebacks
- 99.999% availability (< 5 min downtime/year)

The exactly-once requirement is the most challenging aspect of this design. In a distributed system, you cannot distinguish between "the charge failed" and "the charge succeeded but the response was lost." The solution combines idempotency keys (so retries are safe), write-ahead persistence (so crash recovery knows what was in flight), and background reconciliation (so any divergence between your records and the processor's records is detected and resolved automatically).

---
