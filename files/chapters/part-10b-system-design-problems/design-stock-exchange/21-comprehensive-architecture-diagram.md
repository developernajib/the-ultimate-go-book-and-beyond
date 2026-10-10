## Comprehensive Architecture Diagram

The following diagram shows the full end-to-end flow of an order through the exchange: from retail traders connecting via REST/WebSocket and institutional brokers connecting via the FIX Protocol Gateway, through pre-trade risk checks, into the matching engine's per-symbol order books, and then out to market data subscribers and settlement. The critical latency path (order entry to execution report) runs through the Risk Engine and Matching Engine, which is why those components are co-located on low-latency hardware with kernel bypass networking.

```
Retail Traders                    Institutional Brokers
(REST/WebSocket)                  (FIX Protocol TCP)
     │                                  │
     ▼                                  ▼
┌──────────────┐              ┌──────────────────┐
│   REST/WS    │              │   FIX Gateway    │
│   Gateway    │              │  (session mgmt)  │
└──────┬───────┘              └────────┬─────────┘
       │                               │
       └───────────┬───────────────────┘
                   ▼
         ┌───────────────────┐
         │   Order Gateway   │
         │ - Authentication  │
         │ - Rate limiting   │
         │ - Validation      │
         └─────────┬─────────┘
                   │
         ┌─────────▼─────────┐
         │    Risk Engine    │
         │ - Margin check    │
         │ - Position limit  │
         │ - Fat finger      │
         │ - LULD check      │
         └─────────┬─────────┘
                   │
    ┌──────────────▼───────────────────────────┐
    │               Order Router               │
    │   hash(symbol) -> matching engine node   │
    └─────────────┬─────────────┬──────────────┘
                  │             │
    ┌─────────────▼────┐   ┌────▼─────────────┐
    │ Matching Node 1  │   │ Matching Node N  │
    │ AAPL goroutine   │   │ GOOGL goroutine  │
    │ MSFT goroutine   │   │ AMZN goroutine   │
    │ ...              │   │ ...              │
    │ [WAL + Heap]     │   │ [WAL + Heap]     │
    └────────┬─────────┘   └─────────┬────────┘
             │                       │
    ┌────────▼───────────────────────▼─────────┐
    │           Trade Events (Kafka)           │
    └───┬──────────┬──────────┬──────────┬─────┘
        │          │          │          │
 ┌──────▼───┐ ┌────▼─────┐ ┌──▼───────┐ ┌▼──────────┐
 │ Trade DB │ │  Market  │ │ Surveil- │ │Settlement │
 │ (Audit)  │ │   Data   │ │  lance   │ │ T+1 DVP   │
 │PostgreSQL│ │Publisher │ │  Engine  │ │(clearing) │
 └──────────┘ │ (WS+UDP) │ └──────────┘ └───────────┘
              └───┬──────┘
                  │
            ┌─────▼──────┐
            │Subscribers │
            │ (traders,  │
            │data feeds) │
            └────────────┘
```

---
