# System Design: Payment System - Financial Transactions at Scale

> In payments, correctness is not optional. A rounding bug worth $0.01 per transaction is $1M a day at 100 million transactions a day, and every cent of it is someone else's money.

A payment system is where correctness requirements are absolute. Unlike most distributed systems where eventual consistency is acceptable, a payment platform must guarantee exactly-once semantics: charging a customer twice is a compliance violation, and losing a charge record means unrecoverable revenue. The system must achieve 99.999% availability (less than 5 minutes of downtime per year) while processing millions of financial transactions across 150+ currencies and multiple payment methods.

At 100 million transactions per day (1,160/sec average, 5,000/sec peak during flash sales), the system generates 50GB of transaction data daily and 200 million double-entry ledger records. Every transaction must pass real-time fraud detection in under 100 milliseconds, comply with PCI DSS requirements (never storing raw card numbers), and maintain a complete audit trail for regulatory review. Settlement runs nightly, reconciling internal ledger records against processor statements to catch any discrepancy down to the cent.

The three hardest engineering problems are: (1) achieving exactly-once payment semantics in a distributed environment where network timeouts mean you cannot tell whether a charge succeeded or failed, solved through idempotency keys, write-ahead persistence, and background reconciliation, (2) implementing a double-entry ledger that remains perfectly balanced under concurrent writes and partial failures, since any imbalance indicates data corruption, and (3) building fraud detection that evaluates 500+ features per transaction in under 100ms, balancing false-positive rates (blocking legitimate purchases) against false-negative rates (allowing fraud through).

This chapter walks through the full design:

- **Problem Statement** defines the functional and compliance requirements.
- **Capacity Estimation** translates transaction volumes into storage and throughput targets.
- **Architecture Overview** shows the layered flow from API gateway through payment orchestration, fraud detection, and ledger recording.
- **Core Components** implements the payment service, idempotency store, double-entry ledger, and fraud engine in Go.
- **Database Schema** covers partitioned transaction tables, the immutable ledger, and materialized merchant balances.
- **Key Design Decisions** explains idempotency, exactly-once semantics, double-entry bookkeeping, PCI compliance, and fraud at scale.
- **Interview Follow-Ups** addresses distributed transactions, race conditions in balance updates, and currency conversion.
- **Deep Dives** cover the payment state machine, multi-currency handling, webhook delivery, settlement pipelines, and dispute management.
- **Scaling Strategy, Failure Handling, and Cost Analysis** address production deployment and operational concerns.
