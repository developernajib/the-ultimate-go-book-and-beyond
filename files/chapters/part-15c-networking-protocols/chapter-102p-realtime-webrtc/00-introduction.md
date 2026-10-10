# Chapter 102P: Real-Time Systems & WebRTC with Go

*Real-time communication is not about speed, it's about latency. A system that delivers in 50ms is worth ten that deliver in 500ms.*

When a user edits a shared document and expects to see a collaborator's cursor move in under 100 milliseconds, or joins a video call and expects audio to arrive without perceptible delay, the entire software stack - from WebSocket frame delivery through CRDT merge logic to WebRTC media negotiation - must be designed around latency as a first-class constraint. HTTP request-response semantics were never built for this. Building real-time systems requires a fundamentally different programming model, one that Go's goroutine-per-connection concurrency and non-blocking I/O are exceptionally well suited to support.

Go's combination of lightweight goroutines, channel-based message passing, and the `net` package's low-level socket access makes it one of the strongest languages for high-concurrency real-time infrastructure. The `pion/webrtc` library brings a complete, production-grade WebRTC implementation to Go, enabling engineers to build peer-to-peer video conferencing infrastructure, IoT device communication, and real-time data channels without leaving the Go ecosystem. Understanding WebRTC's signaling, ICE negotiation, DTLS, and SRTP layers - and how to implement them correctly in Go - is increasingly valuable as companies build real-time collaboration features directly into their products.

This chapter builds a complete real-time system stack in Go: WebSocket hubs handling 100K concurrent connections, Server-Sent Events for push notifications, a WebRTC signaling server with SDP offer/answer negotiation, CRDT-based conflict-free collaboration data structures, operational transforms for text editing, and a Redis-backed pub/sub presence system - with full attention to backpressure, connection lifecycle, and production reliability.

**What you'll learn in this chapter:**
- Building WebSocket hubs in Go that handle 100K+ concurrent connections with proper backpressure and slow-client handling
- Server-Sent Events (SSE) for efficient unidirectional push: event streams, reconnection, and connection lifecycle management
- WebRTC architecture: ICE, STUN, TURN, SDP offer/answer negotiation, and peer connection state machine implementation with `pion/webrtc`
- SFU vs. MCU topology trade-offs for multi-party video: latency, cost, and quality implications at different participant counts
- DTLS and SRTP: ensuring encrypted and authenticated media transport in WebRTC sessions
- CRDT data structures for conflict-free real-time collaboration: G-counters, LWW registers, and RGA sequences implemented in Go
- Operational transforms for collaborative text editing: transformation functions, convergence properties, and server-side OT coordination
- Redis-backed pub/sub and presence systems: efficient channel fan-out, presence heartbeats, and horizontal scaling across WebSocket servers

**Why this matters at scale:**
Discord has written publicly about scaling its voice infrastructure to millions of concurrent users (a stack built on Elixir, Rust, and C++ selective forwarding units), and Figma's multiplayer collaboration - serving millions of simultaneous design sessions - relies on the same CRDT and WebSocket patterns covered in this chapter to guarantee conflict-free consistency under concurrent edits.

**Prerequisites:** Chapter 102B (Networking Deep Dive), Chapter 11 (Concurrency & Goroutines), Chapter 34 (Redis & Caching)

### Junior → FAANG: Why Real-Time and WebRTC Are Interview Territory

WebRTC and CRDT interviews are increasingly common at companies building collaboration, communication, or gaming products. The reason: these topics require understanding both distributed systems theory (convergence, consistency models) and network protocol details (ICE negotiation, DTLS, SRTP) simultaneously. Candidates who can discuss both layers fluently stand out.

The entry-level investment is understanding the WebRTC connection flow: signaling (exchanging SDP offer/answer via a channel you implement), ICE negotiation (finding a network path between peers using STUN/TURN), and media transport (DTLS-SRTP for encrypted media delivery). You do not need to have implemented a full SFU to describe this flow correctly.

For CRDTs: the entry-level investment is knowing two concrete examples (G-Counter for increment-only counting, LWW-Register for last-write-wins values) and being able to explain what "conflict-free" means mathematically (the merge function is commutative, associative, and idempotent).

### Senior @ FAANG: Real-Time Systems as Platform Architecture

At FAANG scale, real-time communication infrastructure is a platform problem. Discord, Zoom, and Figma each maintain dedicated real-time infrastructure teams, not because the products are different, but because the operational complexity of WebRTC at scale (SFU clustering, TURN capacity, ICE success rate monitoring, bitrate adaptation) requires dedicated expertise. Understanding where this infrastructure is best owned as a platform versus built per-product is the staff-level architectural question.

The CRDT governance question: which data types in your product require conflict-free merging, and which require a strong consistency guarantee? Getting this wrong is expensive to fix after deployment. A document editor that uses LWW for text edits loses edits silently under concurrent modification. A counter that uses G-Counter cannot be decremented. The data type selection must be driven by the product's consistency requirements, documented before implementation, and enforced by the type system where possible.

