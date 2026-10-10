## Project Overview

We'll build **GoChat** - a production-ready real-time chat application similar to Slack or Discord. The system will support:

- **Real-time messaging** via WebSockets
- **Channels and Direct Messages** (DMs)
- **User presence** (online/offline, typing indicators)
- **Message history** with full-text search
- **File uploads** with image thumbnails
- **Push notifications** for offline users
- **Horizontal scaling** across multiple servers
- **Rate limiting** to prevent abuse
- **End-to-end encryption** concepts

### Why This Project Matters

Real-time chat is a common interview topic and a critical skill for senior engineers:

- **Google**: Real-time collaboration (Google Docs, Google Chat)
- **Meta**: WhatsApp, Messenger, Instagram DMs
- **Slack**: The entire platform is a chat system
- **Discord**: Gaming chat at massive scale
- **Twitch**: Chat at millions of concurrent users
- **Uber**: Driver-rider messaging
- **Doordash**: Customer-driver-restaurant messaging

WebSocket architecture, message brokers, and horizontal scaling are core knowledge areas for staff engineer roles.

### Junior → FAANG: Chat as a Proxy for Distributed Systems Concepts

GoChat's feature list maps directly to distributed systems interview topics. Real-time messaging maps to event delivery and pub/sub. Message history maps to durable log storage and read-after-write consistency. Presence system maps to distributed state with TTL. File sharing maps to object storage and CDN. End-to-end encryption maps to key exchange and cryptographic protocol design.

You do not need to implement all of these for an interview. But understanding conceptually how each is implemented positions you as someone who has thought deeply about the problem space, not just memorized a solution.

For entry-level roles, the WebSocket server alone is sufficient portfolio material. For mid-level roles, add the pub/sub fan-out and presence system. For senior roles, add the delivery guarantee discussion and the horizontal scaling story.

### Senior @ FAANG: Chat as a Platform, Not a Feature

At senior level, a chat application is often a platform that other product features build on. Uber's driver-rider messaging is not a standalone chat app. It is a messaging platform that integrates with the dispatch system, the safety team's monitoring tools, and the trust and safety abuse detection pipeline. Designing that platform requires thinking about the API surface that internal teams consume, not just the end-user experience.

The ADR for a messaging platform must address: who can create channels (anyone, or only authorized services), what message retention policy applies (user-deletable, or audit-required), and how messages are accessed by non-participant systems (compliance monitoring, safety review). Each of those questions has product, legal, and engineering implications. Answering them before the first line of code is written is the difference between a product that can grow and one that requires a painful rewrite when compliance requirements arrive.

---
