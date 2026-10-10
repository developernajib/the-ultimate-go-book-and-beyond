## Architecture Overview

The system is structured around a funnel pattern: millions of users enter the virtual queue, but only a controlled stream reaches the actual booking service. This is the single most important architectural decision because it transforms an unmanageable traffic spike into a predictable, steady flow. The diagram below shows how each layer acts as a gatekeeper, progressively filtering requests so that downstream services (payment, database, ticket delivery) never experience more load than they can handle.

```
User Browser/App
       │
       ▼ (during sale: virtual waiting room first)
┌────────────────────────────────────────────────────┐
│           Virtual Queue Service                    │
│  (fair ordering, bot mitigation)                   │
└──────────────────────┬─────────────────────────────┘
                       │ queue token
                       ▼
┌────────────────────────────────────────────────────┐
│            Ticket Service                          │
│  (inventory, seat selection, holds)                │
└──────────────────────┬─────────────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         ▼                            ▼
    Payment Service             Delivery Service
    (Stripe)                    (QR code generation)
```

---
