## Summary

| Topic | Key Pattern |
|-------|-------------|
| BFF | One endpoint per screen. Aggregate in parallel |
| APNs | JWT auth (not cert). HTTP/2 with `apns-push-type` header |
| FCM | OAuth2 service account, `v1/messages:send` API |
| Offline sync | Client changes + server changes in one round trip |
| Conflict resolution | LWW by default. CRDTs for high-concurrency |
| Compression | gzip middleware with `Accept-Encoding: gzip` |
| Pagination | Cursor-based (not offset) for mobile feeds |
| Session | Access token (1h) + refresh token (30d) per device |
| Analytics | Client-side batching. Server-side enrichment |
| ETags | Cache-Control for unchanged resources → 304 |
| BFF ownership | Per-client at 50-500 engineers, federation above 500 |
| Push delivery | Best-effort, server state authoritative, client reports receipt |
| Push redundancy | APNs plus FCM plus WebPush with provider failover ADR |
| Silent push | Wake-and-pull pattern, not a message bus |
| Sync engine selection | ADR per product, reversal cost is years of engineer-decades |
| Delta sync cursors | Opaque, monotonic, logical sequence not wall-clock time |
| Clock skew defense | Reject client timestamps outside `server_time ± 5min` |
| HTTP/3 for mobile | QUIC at edge, connection migration saves p99 on handoff |
| Mobile versioning | Additive evolution, removal driven by read-traffic metrics |
| Device attestation | App Attest (iOS), Play Integrity (Android), gate high-risk flows |
| Proof of possession | DPoP for device-bound tokens, Secure Enclave or Keystore |
| Token graveyard | Archive on error, never hard-delete, 90-day retention |
| Analytics schema registry | Authoritative, PR-reviewed, drives ingest validation |
| PII scrubbing | At ingest, not at query, crypto-shred for immutable stores |
| GDPR right-to-delete | First-class operation with documented SLA |
| iOS ATT and DMA | Consent state on every event, enforced at processor tier |
| Thundering herd | Jitter push dispatch, jitter client-side backoff |
| Push storm recovery | Smooth backlog drain, do not dispatch as fast as possible |

### Junior → FAANG: Using This Summary As A Study Guide

Treat this table as a flashcard set. For each row, write on the back: the pattern, one production failure mode when the pattern is violated, and one code snippet or config setting that implements the pattern in Go. When you can reproduce all three for every row without looking, you have the junior-to-mid mobile backend fluency. The row where you cannot reproduce all three is your next study target. Do not try to learn everything at once. Pick one row per week, build a toy Go implementation, and then read the corresponding section of this chapter with the hands-on context already installed. This is the pattern that converts textbook reading into transferable skill.

### Senior @ FAANG: The Summary As A Review Checklist

At staff level this table is a review checklist you run against any mobile backend design under your scope. For each row, you should be able to answer: which ADR covers this decision for our product, when was it last reviewed, what is the metric that tells us the decision is still correct, and what is the reversal cost if we got it wrong. A product where that checklist is green across all rows is operating at the senior bar. A product where multiple rows return "no ADR, never reviewed, no metric" is where you focus the next quarter.

The rows that accumulate technical debt fastest, in my observation across multiple teams, are mobile versioning discipline (teams ship additive changes while intending to ship breaking ones, and discover five years later that the cumulative surface is unmaintainable), push delivery observability (teams measure sent, not received, and learn during an incident that they cannot distinguish provider failure from client failure), and analytics schema governance (teams accumulate fields faster than they deprecate them, until the data model becomes a liability). The staff-level intervention for each is not a code change. It is a process change: quarterly deprecation review, push-delivery dashboard with client-reported receipt as the headline metric, and a hard rule that new event fields require a registry entry with a deprecation plan. Processes are harder to ship than code because they require sustained social capital, and that is exactly why they are staff-level work.

---
