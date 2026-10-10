## Extended Architecture: Multi-Region Deployment

Serving users globally from a single region introduces unacceptable latency for real-time editing. A multi-region deployment places WebSocket gateways, document servers, and caches close to users in each major geographic area. The critical design decision is document ownership: each document is pinned to one region (typically the owner's region), and cross-region editors route their operations through that owning region. This adds around 100ms of latency for cross-region collaborators but avoids the complexity of multi-master conflict resolution across regions.

```
                    ┌──────────────────┐
                    │  Global Load     │
                    │  Balancer (DNS)  │
                    └──────┬───────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │  US-East     │ │  EU-West     │ │  AP-South    │
   │              │ │              │ │              │
   │  WS Gateway  │ │  WS Gateway  │ │  WS Gateway  │
   │  Doc Servers │ │  Doc Servers │ │  Doc Servers │
   │  Redis       │ │  Redis       │ │  Redis       │
   │  PostgreSQL  │ │  PostgreSQL  │ │  PostgreSQL  │
   │  S3 (content)│ │  S3 (replica)│ │  S3 (replica)│
   └──────────────┘ └──────────────┘ └──────────────┘

Routing: document assigned to nearest region of its most active editors.
If editors span regions: pin to region of document owner.
Cross-region editing: operations forwarded to owning region, broadcast back.
Latency impact: cross-region adds ~100ms per operation (acceptable).
```

---
