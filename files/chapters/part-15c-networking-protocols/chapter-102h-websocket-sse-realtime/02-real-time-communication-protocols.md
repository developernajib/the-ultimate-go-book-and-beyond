## Architecture Overview: Real-Time Communication Protocols

Choosing the right real-time transport depends on whether the communication is unidirectional or bidirectional, the tolerable per-message overhead, and whether the browser's EventSource API or a full-duplex WebSocket connection better matches the use case. WebSocket performs a one-time HTTP/1.1 upgrade handshake, exchanging `Sec-WebSocket-Key` and `Sec-WebSocket-Accept` headers derived from a SHA-1 hash, and then operates as a framed binary or text stream over the same TCP connection. Server-Sent Events (SSE) are simpler: the server sends a `text/event-stream` response and writes newline-delimited `data:` fields indefinitely, with the browser's EventSource automatically reconnecting on disconnection.

```
┌───────────────────────────────────────────────────────────────────────┐
│              Real-Time Protocol Comparison                            │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Protocol    Direction    Overhead    Use Case                        │
│  ─────────   ─────────    ────────    ────────                        │
│  WebSocket   Bidirect     Low         Chat, gaming, collab editing    │
│  SSE         Server→      Very Low    Live feeds, dashboards, logs    │
│  HTTP/2 Push Server→      Low         Push notifications              │
│  Long-Poll   Server→      Medium      Fallback for SSE                │
│  WebRTC      Peer-to-Peer Very Low    Video, audio, p2p               │
│                                                                       │
│  WebSocket Handshake:                                                 │
│  Client: GET /ws HTTP/1.1                                             │
│          Upgrade: websocket                                           │
│          Connection: Upgrade                                          │
│          Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==                  │
│          Sec-WebSocket-Version: 13                                    │
│                                                                       │
│  Server: HTTP/1.1 101 Switching Protocols                             │
│          Upgrade: websocket                                           │
│          Connection: Upgrade                                          │
│          Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=           │
│                                                                       │
│  SSE:                                                                 │
│  Server: Content-Type: text/event-stream                              │
│          Cache-Control: no-cache                                      │
│          Connection: keep-alive                                       │
│          data: {"type":"update","value":42}\n\n                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading Protocol Comparison Diagrams Under Interview Pressure

Protocol comparison diagrams like the ASCII diagram in this section are useful study tools because they force you to articulate the differences rather than just recognizing them. Practice explaining the diagram out loud: "HTTP long-polling sends a request and keeps the connection open until the server has data or the timeout fires. SSE opens a single long-lived response stream and the server pushes events as they occur. WebSocket upgrades an HTTP connection to a bidirectional channel." This narrated explanation is exactly what interviewers want.

The dimension that most candidates miss when comparing protocols is proxy and load balancer compatibility. Long-polling and SSE use standard HTTP and pass through virtually every proxy without configuration changes. WebSocket requires the proxy to understand the `Upgrade: websocket` header and to hold the connection open indefinitely. Some corporate proxies and CDNs have historically broken WebSocket by terminating idle connections. Mentioning this in a protocol comparison question shows production awareness.

### Senior @ FAANG: Protocol Selection as an Architectural Commitment

Protocol selection for a real-time system is a commitment that is expensive to reverse. A product that launches with long-polling and wants to migrate to WebSocket later must update every client (mobile apps, web clients, third-party integrations) simultaneously or run both protocols in parallel during a transition period. The platform design should anticipate growth: if the product's current use case is server-to-client notifications but future use cases will require bidirectional interaction, choosing WebSocket from the start avoids a later migration.

At FAANG scale, the protocol layer is often abstracted behind a real-time gateway service that translates between client-facing WebSocket connections and internal event bus messages. This abstraction allows the internal event delivery mechanism (Kafka, NATS, Redis Streams) to evolve independently of the client-facing protocol, and allows different client types (mobile, web, partner API) to use different protocols while receiving the same event stream. Designing this abstraction layer is a staff-level architecture problem that requires understanding all the protocol options and their operational tradeoffs.

---
