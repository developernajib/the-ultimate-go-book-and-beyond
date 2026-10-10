## Learning Objectives

By the end of this chapter, you will:
- Understand mobile-specific API patterns including Backend-for-Frontend (BFF) aggregation, response shaping for small screens, and reducing round trips over unreliable networks
- Be able to implement push notifications for both FCM (Android/cross-platform) and APNs (iOS), including token management, payload construction, and delivery receipts
- Know how to design offline-first sync strategies using last-write-wins, vector clocks, or operational transforms to handle conflict resolution when clients reconnect
- Be able to implement delta sync - sending only changed records since a client's last known cursor - to minimize bandwidth and battery consumption
- Understand authentication patterns for mobile clients including JWT refresh token rotation, device fingerprinting, biometric auth integration, and silent re-authentication
- Know how to apply bandwidth optimization techniques such as response compression (gzip/brotli), field masking, pagination, and conditional GET with ETags
- Be able to implement binary protocols (Protocol Buffers, MessagePack) as alternatives to JSON for latency- and bandwidth-sensitive mobile APIs
- Know how to test mobile backend services including simulating intermittent connectivity, testing push notification delivery, and load testing concurrent device connections

### Junior → FAANG: How to Read These Objectives

Treat this list as a readiness checklist, not a reading list. For each bullet, ask yourself: could I whiteboard the core data flow in fifteen minutes, write a toy Go implementation in an afternoon, and debug a production incident in that area at 3am with an on-call page? If the answer to any of those three is no, that bullet is the one to spend time on before moving to the next chapter. The interview signal for new grads on mobile backend rotations is not knowing every bullet deeply. It is being able to say honestly which two you know cold, which two you can reason about, and which two you would need to pair with a senior engineer on for the first week. That self-awareness reads as staff-track behavior even in a new-grad loop.

Worked starting points for each objective. For BFF, implement a Go service that fans out to three mock downstream services with `errgroup` and returns a shaped response under 5KB. For push, integrate the `github.com/sideshow/apns2` and FCM HTTP v1 clients and send one real notification to a test device. For offline sync, implement last-write-wins on a single table with a `updated_at` column and a client-supplied cursor. For delta sync, extend that with a `since` query parameter. The goal is not completeness. The goal is to have touched each concept with working code so the vocabulary is grounded.

### Senior @ FAANG: The Objectives Behind the Objectives

At staff level the learning objectives listed above are table stakes. The objectives that actually determine promotion and scope are not in the bullet list because they are not technical skills. They are architectural judgment calls that the chapter teaches through examples. Read the chapter with these senior-track objectives in mind.

First, be able to write and defend a BFF-versus-federation ADR for a specific product at a specific scale. The answer is not in a textbook. It depends on team topology, client version skew tolerance, and the rate of schema change. Second, be able to run a push outage postmortem that distinguishes provider failure from token lifecycle failure from fan-out service failure. These three look identical to the user (no notification arrived) and have completely different remediations. Third, be able to choose a sync engine for a new product and justify it against the three reversal-cost-high alternatives. Fourth, be able to design an analytics ingest pipeline that meets GDPR right-to-delete and DMA data-portability requirements without retroactively rewriting historical events, which means getting the schema registry and PII scrubbing right at ingest time rather than at query time. Fifth, be able to own the mobile rollout story end to end: feature flags synced to offline clients, forced-update floors, staged cohort rollout, and rollback protocols when a bad client version is already on a hundred million devices. None of these show up in a code review. All of them show up in a promotion packet.
