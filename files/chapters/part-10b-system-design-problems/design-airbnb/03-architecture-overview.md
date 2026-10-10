## Architecture Overview

The high-level architecture splits the system into two primary flows: search and booking. Search is read-heavy and latency-sensitive, so it is powered by Elasticsearch with Redis caching. Booking is write-heavy and demands strong consistency, so it uses PostgreSQL with Redis-based optimistic locking. The API Gateway routes guest and host requests to the appropriate service, and the Booking Service coordinates with both the Payment Service (Stripe) and the Availability Service to ensure dates are never double-booked.

```
Guest/Host App
        │
        ▼
┌─────────────────────────────────────────────────┐
│                 API Gateway                     │
└──────────┬──────────────────┬───────────────────┘
           │                  │
    ┌──────▼──────┐    ┌──────▼──────┐
    │  Search     │    │  Booking    │
    │  Service    │    │  Service    │
    │ (Elastic-   │    │ (PostgreSQL)│
    │  search)    │    └──────┬──────┘
    └─────────────┘           │
                         ┌────┴─────────────┐
                         ▼                  ▼
                    Payment Service    Availability Service
                    (Stripe)           (Redis + PostgreSQL)
```

---
