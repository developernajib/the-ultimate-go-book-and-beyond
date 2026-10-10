## Complete Architecture Diagram (Detailed)

This diagram shows the full end-to-end architecture with all components and their connections. Follow the flow from top to bottom: advertisers manage campaigns through the portal, which syncs targeting data into Redis. When a publisher's page loads an ad tag, the request flows through the CDN for creative assets and the Ad Exchange for the auction. After serving, all events flow through Kafka to three downstream consumers: ClickHouse for analytics, the fraud ML pipeline for offline detection, and the billing system for monthly invoicing. Understanding this complete picture helps you explain how data flows through the system during an interview.

```
                                    ┌─────────────────────┐
                                    │   Advertiser Portal │
                                    │   (Campaign CRUD)   │
                                    └──────────┬──────────┘
                                               │
                                    ┌──────────▼──────────┐
                                    │   Campaign Service  │
                                    │   (PostgreSQL)      │
                                    └──────────┬──────────┘
                                               │ sync targeting index
                                    ┌──────────▼──────────┐
                                    │   Redis Cluster     │
                                    │   - Budget tracking │
                                    │   - Targeting index │
                                    │   - Frequency caps  │
                                    │   - Fraud velocity  │
                                    └──────────┬──────────┘
                                               │
Publisher Website/App                          │
         │  Ad Tag JS                          │
         ▼                                     │
┌────────────────┐     ┌───────────────────────▼────────────────────┐
│  CDN Edge      │     │              Ad Exchange                    │
│  (Creative     │     │                                             │
│   Assets)      │     │  ┌─────────┐  ┌──────────┐  ┌───────────┐ │
└────────────────┘     │  │ Request │  │ Targeting│   │  Budget   │ │
                       │  │ Parser  │──│  Engine  │ ──│  Check    │ │
                       │  └─────────┘  └──────────┘  └───────────┘ │
                       │       │                           │         │
                       │  ┌────▼────────────────────────┐  │         │
                       │  │     Auction Engine           │  │         │
                       │  │  (parallel DSP calls, 80ms) │  │         │
                       │  └────┬────────────────────────┘  │         │
                       │       │                           │         │
                       │  ┌────▼────┐  ┌──────────┐       │         │
                       │  │ Winner  │  │  Fraud   │       │         │
                       │  │ Select  │──│  Check   │       │         │
                       │  └────┬────┘  └──────────┘       │         │
                       └───────┼──────────────────────────┘         │
                               │                                     │
                    ┌──────────▼──────────┐                          │
                    │    Ad Response       │                          │
                    │  (markup + tracking) │                          │
                    └──────────┬──────────┘                          │
                               │                                     │
                    ┌──────────▼──────────┐                          │
                    │    Event Pipeline    │                          │
                    │    (Kafka)           │                          │
                    │  - impressions       │                          │
                    │  - clicks            │                          │
                    │  - conversions       │                          │
                    │  - viewability       │                          │
                    └──────────┬──────────┘                          │
                               │                                     │
              ┌────────────────┼────────────────┐                   │
              ▼                ▼                ▼                    │
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
    │  ClickHouse  │  │   Fraud ML   │  │   Billing    │           │
    │  (Analytics) │  │  (Offline)   │  │  (Monthly)   │           │
    └──────────────┘  └──────────────┘  └──────────────┘           │
```

---
