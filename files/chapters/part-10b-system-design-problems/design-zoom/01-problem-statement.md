## Problem Statement

Video conferencing is one of the most demanding distributed systems to build because it requires real-time media delivery with extremely low latency across the globe. Unlike a chat application where a few hundred milliseconds of delay is acceptable, video calls feel broken if audio lags by even 300 milliseconds. The system must also handle wildly different network conditions, some participants are on fiber, others on spotty mobile connections, and gracefully adapt quality for each one independently.

Design Zoom supporting:
- 30M daily meeting participants
- 100K concurrent meetings (3M participants) at peak
- Up to 1000 participants per meeting (webinar mode)
- < 150ms one-way audio latency, < 300ms video latency
- Screen sharing, recording, virtual backgrounds
- Waiting rooms, breakout rooms
- End-to-end encryption (optional)
- Reliability: meeting continues if host loses connection

---
