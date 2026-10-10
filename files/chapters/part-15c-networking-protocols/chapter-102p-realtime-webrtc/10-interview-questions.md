## 102P.8 Core Real-Time & WebRTC Interview Questions

**Q: When would you choose WebSockets over SSE?**

A: WebSockets are bidirectional - use them when clients send data back (chat, collaboration, gaming). SSE is server-to-client only - use it for push notifications, live feeds, progress updates. SSE has automatic reconnection built into browsers, works over standard HTTP (through proxies), and is simpler to implement. For most "live dashboard" use cases, SSE is sufficient and easier to scale.

**Q: What is the WebRTC signaling process?**

A: (1) Alice creates an SDP offer (Session Description Protocol - codec/ICE capabilities). (2) Alice sends offer to signaling server → Bob. (3) Bob creates an SDP answer and sends back. (4) Both sides gather ICE candidates (UDP paths for media). (5) ICE candidates are exchanged via signaling server. (6) STUN/TURN servers help traverse NAT. Once ICE negotiation succeeds, media flows peer-to-peer (bypassing signaling server).

**Q: How do CRDTs differ from OT for collaborative editing?**

A: Both achieve conflict-free collaboration, but differently. OT requires a central server to transform operations in sequence - easier to implement but centralized. CRDTs are purely decentralized - each peer can apply operations independently and convergence is guaranteed by mathematical properties. OT is used by Google Docs. CRDTs are used by Figma, Notion, and offline-first apps. For text editing, CRDT algorithms like YATA (Y.js) or RGA provide better performance than naive OT.

### Junior → FAANG: Building Strong Answers to the WebSocket vs SSE Question

The WebSocket vs SSE question is the most common real-time protocol interview question and has a structure that rewards preparation. The answer has three dimensions: directionality (WebSocket is bidirectional, SSE is server-to-client only), browser compatibility and reconnection (SSE's EventSource reconnects automatically with Last-Event-ID, WebSocket requires custom reconnection logic), and infrastructure compatibility (SSE is plain HTTP, WebSocket requires proxy support for the Upgrade header).

The question you should be asking yourself during a WebSocket vs SSE question: "does the client ever send data after the connection is established, and with what frequency?" If the answer is "rarely, and REST requests are acceptable," SSE is likely the better choice. If the answer is "frequently and with low latency requirements," WebSocket is necessary.

### Senior @ FAANG: The OT vs CRDT Choice as a Platform Decision

At L6, the OT vs CRDT question is a platform decision with a five-year time horizon. Choosing OT means accepting the central server constraint, which limits offline-first features and multi-region active-active deployment. Choosing CRDTs means accepting the GC complexity and the limited set of supported data structures. Neither choice is universally correct.

The decision framework: start with product requirements. Does the product need offline editing? Does it need conflict resolution that preserves user intent (OT is better for this, CRDTs have LWW which may discard work)? Does it need to support multiple concurrent editors across geographic regions without a central coordinator (CRDTs)? Does the team have the expertise to implement and debug CRDT GC (if not, OT's simpler operational model may be preferable despite its limitations)?

Document the decision in an ADR that includes the product requirements, the alternatives considered, the decision made, and the constraints it imposes on future feature development. The most common architectural regret in collaborative editing systems is discovering two years after launch that the chosen approach (OT or CRDT) cannot support a new product requirement without a full rewrite.

