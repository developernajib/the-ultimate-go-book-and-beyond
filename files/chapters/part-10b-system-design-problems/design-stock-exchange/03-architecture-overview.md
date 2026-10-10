## Architecture Overview

The architecture follows a pipeline pattern where each stage has a single, focused responsibility. Orders flow in through an API gateway, get routed to the correct matching engine by ticker symbol, and matched trades fan out to both a persistent trade processor and a real-time market data publisher. This separation ensures that slow consumers (like databases or lagging WebSocket clients) never block the critical matching path. Notice how the matching engine sits at the center: it is the heart of the exchange, and everything else is designed to feed it orders and consume its output as efficiently as possible.

```
Broker / Trader API
         │  FIX Protocol / REST
         ▼
┌────────────────────────────────────────────────┐
│                 Order Gateway                  │
│  (authentication, rate limiting, validation)   │
└───────────────────────┬────────────────────────┘
                        │  Order submission
                        ▼
┌────────────────────────────────────────────────┐
│                  Order Router                  │
│ (routes to correct matching engine by ticker)  │
└───────────────────────┬────────────────────────┘
                        │
         ┌──────────────▼──────────────┐
         │       Matching Engine       │
         │   (one per ticker symbol)   │
         │    Order Book (in-memory)   │
         └──────────────┬──────────────┘
                   │ Trade events
    ┌──────────────┴──────────────┐
    ▼                             ▼
Trade Processor              Market Data Publisher
(settlement, clearing)       (WebSocket broadcast)
    │                             │
    ▼                             ▼
Trade DB                     Subscribers
(audit log)                  (traders, data vendors)
```

---
