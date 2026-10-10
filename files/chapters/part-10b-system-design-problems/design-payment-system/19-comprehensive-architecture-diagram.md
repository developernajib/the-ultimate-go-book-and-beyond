## Comprehensive Architecture Diagram

The diagram below shows how all the components connect end-to-end, from the client's browser to the settlement and dispute services. Notice that raw card data never touches your servers: the browser sends card details directly to the processor (via Stripe.js or a similar library), and your system only ever handles opaque tokens. This is a critical PCI DSS design choice that dramatically reduces your compliance scope and audit burden.

```
Client (Browser/Mobile)
         │
    ┌────▼─────┐     ┌────────────────────────────┐
    │ Stripe.js│────>│  Card Processor (Stripe)   │
    │ (card    │     │  - Tokenization            │
    │  data)   │     │  - PCI DSS scope           │
    └──────────┘     └────────────┬───────────────┘
                                  │ Token (pm_xxx)
    ┌─────────────────────────────▼─────────────────────┐
    │                    API Gateway                    │
    │  - Rate limiting (per merchant)                   │
    │  - Authentication (API key + webhook signatures)  │
    │  - TLS 1.3 termination                            │
    └───────────────────┬───────────────────────────────┘
                        │
         ┌──────────────▼───────────────────────┐
         │           Payment Service            │
         │                                      │
         │  ┌───────────┐   ┌───────────────┐   │
         │  │Idempotency│   │    State      │   │
         │  │  Lock +   │   │   Machine     │   │
         │  │  Check    │   │    (DB)       │   │
         │  │  (Redis)  │   └───────┬───────┘   │
         │  └─────┬─────┘           │           │
         │        │                 │           │
         │  ┌─────▼──────┐          │           │
         │  │   Fraud    │          │           │
         │  │   Engine   │ gates    │           │
         │  │ (ML+rules) ├──────┐   │           │
         │  └────────────┘      │   │           │
         │                ┌─────▼───▼────────┐  │
         │                │  Card Processor  │  │
         │                │ (charge/refund)  │  │
         │                └────────┬─────────┘  │
         │                         │            │
         │                  ┌──────▼─────┐      │
         │                  │   Ledger   │      │
         │                  │  (double-  │      │
         │                  │   entry)   │      │
         │                  └────────────┘      │
         └──────────────┬───────────────────────┘
                        │
           ┌────────────┼────────────┐
           ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────────┐
    │ Webhook  │ │Settlement│ │   Dispute    │
    │ Delivery │ │ Pipeline │ │   Service    │
    │ (async)  │ │ (nightly)│ │              │
    └──────────┘ └──────────┘ └──────────────┘
```

---
