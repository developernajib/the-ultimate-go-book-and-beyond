## Architecture Overview

The architecture follows a layered approach where the API Gateway handles cross-cutting concerns like rate limiting and TLS termination, while the Payment Service acts as the central orchestrator. Fraud detection runs in parallel with the payment flow to keep latency low. After a successful charge, the Ledger Service records balanced double-entry journal entries, and the Notification Service informs merchants and customers asynchronously. This separation of concerns allows each component to scale independently and fail without bringing down the entire system.

```
Client (Web/Mobile/API)
        │  HTTPS
        ▼
┌────────────────────────────────┐
│       API Gateway              │   (rate limiting, auth, TLS termination)
└──────────────┬─────────────────┘
               │
    ┌──────────┴───────────────────────┐
    ▼                                  ▼
Payment Service                  Fraud Detection
(orchestrates flow)              (ML model, < 50ms)
    │                                  │
    │◄─ fraud_score ────────────────── ┘
    │
    ▼
Card Processor Client
(Stripe/Adyen/direct card networks)
    │
    ▼
Ledger Service          Notification Service
(double-entry)          (webhooks, email, push)
```

---
