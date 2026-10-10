# System Design: Stock Exchange - High-Frequency Trading Platform

> A stock exchange is a correctness problem disguised as a performance problem. At 1M orders/sec, even nanosecond-level coordination matters.

A stock exchange is the most latency-sensitive distributed system you can design. The matching engine must process 1 million orders per second with sub-millisecond matching latency, maintain price-time priority (FIFO) across all participants, and guarantee zero order loss even during hardware failures. Every nanosecond of added latency creates an unfair advantage for co-located traders, so the critical path must be ruthlessly optimized.

At peak load, the system handles 1M orders/sec across 10,000 listed securities, producing approximately 200,000 trade executions per second (20% fill rate) and broadcasting 1 million market data updates per second to subscribed traders. The order book for each security maintains roughly 400 price levels (200 bid + 200 ask), totaling 4 million active price levels system-wide. Raw order storage grows at 17TB per day, and regulators require a complete, immutable audit trail of every order ever submitted.

The three hardest engineering problems are: (1) achieving deterministic sub-millisecond matching by keeping the entire order book in memory with zero garbage collection pauses, using integer arithmetic for prices, and writing to the WAL with O_DIRECT to bypass OS caching, (2) ensuring zero order loss through a write-ahead log that persists every order before matching begins, combined with hot-standby failover that can reconstruct the full order book state in under 30 seconds, and (3) preventing market manipulation through circuit breakers (halting trading when prices move too fast), spoofing detection (flagging orders layered to display liquidity that is pulled before it can trade), and wash trade detection (identifying self-trading).

This chapter walks through the full design:

- **Problem Statement** defines the functional requirements and performance constraints.
- **Capacity Estimation** translates order volumes into compute, storage, and network targets.
- **Architecture Overview** shows the pipeline from order gateway through matching engine to market data broadcast.
- **Core Components** implements the order book (heap-based with price-time priority), matching engine coordinator (one goroutine per symbol), and market data service (WebSocket broadcast) in Go.
- **Database Schema** covers the immutable order audit log, trade records, and position snapshots.
- **Key Design Decisions** explains the one-goroutine-per-symbol model, WAL persistence, integer price representation, and lossy market data delivery.
- **Interview Follow-Ups** addresses sub-millisecond latency, matching engine recovery, and market manipulation prevention.
- **Deep Dives** cover the order gateway with risk checks, WAL recovery, settlement and clearing, market surveillance, and FIX protocol gateway.
- **Scaling Strategy, Failure Handling, and Cost Analysis** complete the production design.
