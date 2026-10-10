## Architecture

┌────────────────────────────────────────────────────────────────┐
│ REAL-TIME CHAT SYSTEM │
├────────────────────────────────────────────────────────────────┤
│ │
│ ┌──────────┐ ┌───────────────┐ ┌──────────────────────┐ │
│ │ Client │───▶│ WebSocket │───▶│ Chat Service │ │
│ │ │ │ Gateway │ │ │ │
│ └──────────┘ └───────────────┘ └──────────────────────┘ │
│ │ │ │
│ ▼ ▼ │
│ ┌───────────────┐ ┌──────────────────────┐│
│ │ Presence │ │ Message Store ││
│ │ Service │ │ (Cassandra) ││
│ │ (Redis) │ └──────────────────────┘│
│ └───────────────┘ │ │
│ ▼ │
│ ┌──────────────────────┐│
│ │ Message Queue ││
│ │ (Kafka) ││
│ └──────────────────────┘│
│ │
└────────────────────────────────────────────────────────────────┘


### Junior → FAANG: Chat System Core Architecture

A chat system architecture must handle three distinct flows: message send (client to server to recipient delivery), message storage (persisting messages for history and offline delivery), and presence (tracking which users are online and on which server). The minimal architecture includes a WebSocket gateway layer, a message routing service, a message storage database (optimized for time-series append), and a presence service. Do not combine the routing and storage responsibilities into one service: routing is latency-sensitive and must not block on slow storage operations.

### Senior @ FAANG: Chat Architecture at Platform Scale and Multi-Region Operation

At the senior level, the chat architecture must account for multi-region operation, which introduces the cross-region message routing problem. If user A is in the US region and user B is in the EU region, the message send must traverse regions. The two approaches are: route through a global message bus (Kafka with cross-region replication), or route directly between regional gateways. The global message bus approach is simpler but adds latency. Direct routing is faster but requires each region to maintain a directory of all connected users globally. The governance concern at the staff level is data residency: EU regulations may require that messages from EU users be stored in EU infrastructure, even if the recipient is in another region. This constrains the message routing and storage architecture in non-trivial ways. Multi-region architectures also require a careful failure mode analysis: if the US region is partitioned from EU, can EU users still chat with each other? The answer requires explicit decisions about what to do with the global presence index.
