## 102H.8 Foundational Interview Questions

**Q: When would you choose SSE over WebSocket?**

A: Choose SSE when: (1) Communication is server-to-client only (notifications, live feeds, logs). (2) You need automatic reconnection with event replay (built into the EventSource API). (3) You're behind proxies/CDNs that buffer WebSocket connections. (4) HTTP/2 multiplexing is more important than ultra-low latency. Choose WebSocket when: (1) You need bidirectional communication (chat, collaborative editing). (2) You need binary frames (game state, binary protocols). (3) You need sub-10ms round-trip latency. (4) You're building a protocol layered on top of the WebSocket frame layer.

**Q: How do you scale WebSocket servers horizontally?**

A: WebSocket servers are stateful (connections are sticky to one server). Scale with: (1) Redis pub/sub: publish room messages to Redis. All servers subscribe and deliver to local clients. (2) Sticky load balancing: route clients by user ID hash to the same server. (3) Session externalizing: store connection metadata in Redis so any server can "own" the session after reconnection. (4) Consistent hashing: route rooms to specific servers (Slack's model: each channel has a home server). The key insight: don't fight WebSocket statefulness - embrace sticky routing and use Redis for cross-server delivery.

**Q: What is the coordination omission problem in WebSocket real-time systems?**

A: When a client disconnects, it misses messages published during the disconnect. On reconnect, the client may display stale state. Fix: (1) Message buffer: keep the last N messages in memory (with IDs). (2) Client sends `Last-Event-ID` (SSE) or last sequence number (WebSocket) on reconnect. (3) Server replays missed messages from the buffer. This requires message IDs and a bounded replay buffer. Redis Streams provide an excellent backend for this: each event has a stream ID, and `XREAD COUNT 100 STREAMS room: lastID` replays missed events.

### Junior → FAANG: Interview Question Preparation Depth

These questions have a standard answer and a depth answer. "When would you choose SSE over WebSocket?" The standard answer is "SSE for unidirectional, WebSocket for bidirectional." The depth answer adds: "SSE also makes more sense when you need automatic browser-level reconnection with `Last-Event-ID` replay, when your infrastructure has proxies that may not support WebSocket upgrades, and when you want to benefit from HTTP/2 multiplexing without additional connection management."

Practice giving depth answers, not just standard answers. Interviewers at FAANG ask the standard question to see if you can get past the surface-level answer to the nuance. The nuance here is proxy compatibility, HTTP/2 multiplexing, and the automatic reconnection behavior that SSE provides out of the box.

For the "how does your system handle 10 million concurrent connections" question: the answer is not a single number or a single technology. It is a description of the architectural tiers (connection servers, routing tier, message tier) and the resource math (each connection is ~X KB of memory, 10M connections requires ~Y GB across Z servers, with goroutine scheduling overhead of W%).

### Senior @ FAANG: The Follow-Up Questions That Determine Level

Each question in this section has follow-up questions that determine whether a candidate is L5 or L6. For "how does your system handle missed messages?": the follow-up is "what is your replay buffer's retention policy and how did you determine it?" The L5 answer picks a number ("I'd keep 1,000 messages"). The L6 answer derives the number from the product requirement: "the product SLA is that a client that disconnects for up to 60 seconds should recover all missed messages. Given a p99 message rate of 10 messages per second, 600 messages is the minimum buffer. I'd size it at 2x for headroom, so 1,200 messages, stored in Redis with a 5-minute TTL."

For "how do you scale to 10M concurrent connections?": the follow-up is "how do you handle a burst where 1M users reconnect simultaneously after a brief service disruption?" This is the thundering herd problem for WebSocket reconnection. The L6 answer includes exponential backoff with jitter on the client side, a connection rate limiter on the server side, and a pre-warming strategy for the routing tier to handle the surge without cascading failures.

---
