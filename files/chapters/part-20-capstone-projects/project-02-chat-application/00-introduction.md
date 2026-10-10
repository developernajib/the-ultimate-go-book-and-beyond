# Capstone Project 2: Real-Time Chat Application

**Difficulty**: Intermediate+
**Estimated Time**: 3-4 weeks
**Target**: Production-ready Slack/Discord-like chat system
**Tech Stack**: Go 1.27+, WebSockets, PostgreSQL, Redis, S3

---

### Junior → FAANG: Real-Time Systems as a Career Differentiator

Most junior engineers have built REST APIs. Fewer have built WebSocket servers. Real-time system design appears frequently in FAANG interviews because it tests concurrency understanding in a context that is impossible to fake: either your goroutine management is correct or your server leaks connections under load.

Before your interview, be able to explain the WebSocket upgrade handshake (HTTP 101 Switching Protocols), the difference between HTTP and WebSocket framing, and how your server handles a client that disconnects without sending a close frame. These are standard probe questions for any real-time systems role.

For a first job, understanding that long-lived connections require different server resource planning than short-lived HTTP connections is a key concept. A server handling 10,000 concurrent WebSocket connections has 10,000 goroutines (or equivalent) in steady state. That is a memory and scheduling concern, not just a throughput concern.

### Senior @ FAANG: Real-Time at Scale Is an Organizational Challenge

At senior level, the hardest part of a chat system is not the WebSocket protocol. It is message ordering, delivery guarantees, and cross-datacenter fan-out. Each of these is an architectural commitment with operational consequences.

Message ordering within a channel requires that all messages for a given channel pass through a single ordering point, whether a Kafka partition or a Redis sorted set with monotonically increasing sequence numbers. Allowing multiple writers to a channel without an ordering point produces a race condition where two simultaneous messages can appear in different order on different clients. The ADR for message ordering should document the chosen mechanism and the maximum reordering window the product accepts.

Cross-server fan-out via Redis Pub/Sub (used in this project) has a known scalability limit. Redis Pub/Sub is single-threaded in the publisher path. At tens of thousands of messages per second with thousands of subscribers, Redis becomes the bottleneck. Production systems at Slack scale use Kafka with per-channel partitioning: each channel maps to a Kafka partition, and WebSocket servers consume their relevant partitions. That architecture decouples producer throughput from subscriber count.

---
