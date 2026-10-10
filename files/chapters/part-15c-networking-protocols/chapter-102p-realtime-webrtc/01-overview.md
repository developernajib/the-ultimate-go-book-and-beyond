## Architecture Overview: Real-Time Systems & WebRTC Architecture

Real-time systems power video calls, live collaboration, gaming, financial tickers, and IoT dashboards. Go's goroutine model, non-blocking I/O, and excellent networking libraries make it ideal for high-concurrency real-time workloads. This chapter covers WebSockets at scale, Server-Sent Events, WebRTC signaling, CRDT-based collaboration, and building a complete real-time collaboration system.

After this chapter you will be able to:
- Build WebSocket hubs that handle 100K concurrent connections
- Implement Server-Sent Events for push notifications
- Build a WebRTC signaling server for peer-to-peer media
- Design CRDT data structures for conflict-free real-time collaboration
- Implement operational transforms (OT) for collaborative text editing
- Build a real-time presence and pub/sub system with Redis
- Handle backpressure, slow clients, and connection lifecycle

### Junior → FAANG: Which Objectives to Prioritize for Interview Readiness

The seven objectives form a roughly increasing order of interview difficulty and production complexity. Start with WebSocket hubs and SSE (objectives 1-2) because they appear in the broadest set of interview questions. Then WebRTC signaling (objective 3) because it appears at companies building communication products. CRDTs and OT (objectives 4-5) appear at companies building collaboration products and are increasingly common as collaborative features become standard.

Presence and pub/sub (objective 6) and backpressure handling (objective 7) are implementation depth questions that appear once a candidate has demonstrated knowledge of the higher-level concepts. They reward engineers who have actually operated real-time systems and encountered the operational challenges.

Interview positioning: for a generalist backend interview, WebSocket hub design plus Redis pub/sub is the primary target. For a product-specific interview at a collaboration or communication company, add WebRTC signaling and CRDT fundamentals.

### Senior @ FAANG: The Objectives That Separate Platform Engineers from Feature Engineers

At senior level, the objectives that distinguish platform thinking from feature thinking are objectives 3 (WebRTC signaling), 6 (presence system), and 7 (backpressure). These three are where the product complexity meets the infrastructure complexity. A feature engineer implements WebRTC signaling for one product. A platform engineer designs a signaling service that supports multiple products, with defined SLAs for signaling latency and ICE success rate, horizontal scaling, and geographic routing.

The presence system objective at platform scale requires understanding the CAP theorem tradeoffs: a strongly consistent presence system (where every server always has the same view of who is online) requires consensus, which is expensive. An eventually consistent presence system (where servers may temporarily disagree about who is online) is much cheaper to operate but requires the product to tolerate brief inconsistency. Most production presence systems choose eventual consistency and design the UX to handle it gracefully (a user may appear offline for a few seconds after going online).

---
