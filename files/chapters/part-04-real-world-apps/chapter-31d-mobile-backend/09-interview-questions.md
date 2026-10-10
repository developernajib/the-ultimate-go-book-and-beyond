## Interview Questions

**Q: How do you design a mobile API that works on 2G networks?**

A: (1) BFF pattern - one endpoint per screen, no waterfall of requests. (2) Aggressive compression - Brotli (`br`) when the client advertises it, gzip fallback (4-10× reduction). (3) Sparse fieldsets - `?fields=id,name` to request only needed fields. (4) ETags for conditional requests - `304 Not Modified` if data unchanged. (5) CDN for static assets - serve images from edge. (6) Binary protocols (Protobuf, MessagePack, CBOR) vs JSON - 2-3× smaller for structured data. protobuf when you own both ends. (7) Optimistic updates - don't wait for server confirmation. (8) Connection reuse - HTTP/2 or HTTP/3 to avoid per-request TLS handshakes. The handshake cost on 2G often exceeds the payload transfer time.

**What FAANG expects:** You lead with the *measurement*, p95 latency on 2G is RTT-bound (600-1200 ms per round trip), not bandwidth-bound, so the architecturally correct fix is removing round trips (BFF aggregation, HTTP/2 multiplexing, optimistic UI) before tuning payload bytes. They want to hear the distinction and the order of optimizations.

Follow-ups they'll probe:
- How would you test this? (Network Link Conditioner on iOS, `tc netem` in CI, synthetic 2G profiles in Charles/mitmproxy.)
- What's the failure mode of optimistic updates? (Client must reconcile on server rejection, design a rollback path with a user-visible "sync failed" state, never silent discard.)
- When is gRPC/Connect worth it over JSON? (First-party mobile apps with shared schema. Not worth the toolchain tax for partner APIs.)

---

**Q: How do APNs and FCM tokens expire?**

A: APNs tokens become invalid when: user uninstalls the app, user reinstalls the app, user restores device from backup, Apple invalidates the token. FCM tokens refresh periodically or on app reinstall. Best practice: (1) Refresh token on every app launch, (2) Handle `Unregistered` / `InvalidRegistration` / `BadDeviceToken` errors by deleting tokens from the DB synchronously in the push path, (3) Use topic-based messaging (FCM topics, APNs broadcast) to avoid storing tokens for broadcast, (4) Timestamp each token row with `last_validated_at` and purge tokens unseen for 60+ days, stale tokens incrementally leak storage and degrade delivery metrics.

**What FAANG expects:** The key insight is that *token lifecycle is a distributed systems problem*: the client, the push gateway, and your backend all hold partial views, and they must converge without user-visible failure. Candidates who only describe the happy path get filtered out. They want to hear delete-on-error, last-seen tracking, and the fact that `200 OK` from APNs/FCM does not guarantee delivery (just acceptance for delivery).

Follow-ups they'll probe:
- How do you detect a token that was silently invalidated without a push attempt? (Silent push heartbeat + server-side reaper by `last_seen_at`.)
- What happens if two devices share a token after a restore-from-backup? (Shouldn't, APNs issues fresh tokens on restore, but defend with `(user_id, device_id)` uniqueness, not `(token)`.)
- How does FCM v1 OAuth2 fail, and how do you recover? (Service account token source caches. Rotate the underlying service-account key annually with a canary deploy.)

---

**Q: How do you handle sync conflicts in an offline-first mobile app?**

A: Common strategies: (1) Last-Write-Wins (LWW) - simplest, use server timestamp as tiebreaker (never client time, clock skew invalidates). (2) Vector clocks - detect *true* concurrency (non-comparable clocks) so the server can surface a real conflict to the UI instead of silently overwriting. (3) CRDTs - mathematically conflict-free merging for commutative data (G-Counter/PN-Counter for numbers, OR-Set for tags, RGA or Yjs/Automerge for collaborative text). (4) Operational Transform - historically used by Google Docs. largely superseded by CRDTs in 2026 because CRDTs don't require a central server to transform operations. (5) Application-specific three-way merge - custom logic against the last known common ancestor, for document-shaped data. Default to server-authoritative LWW for 80% of records (profile fields, flags), and escalate to vector clocks or CRDTs per entity when concurrent offline edits are a feature, not an edge case.

**What FAANG expects:** A senior answer maps the *data type* to the *conflict model* and names the trade-off: LWW is free but silently lossy, CRDTs preserve intent but carry metadata overhead (often 2-10× the raw data size) and require careful selection of the CRDT variant. They want to hear you pick per-entity, not globally.

Follow-ups they'll probe:
- Walk me through a PN-Counter CRDT merge, why is it commutative? (Each node tracks its own increments + decrements. Merge = element-wise max. Value = sum of increments minus sum of decrements.)
- How do you handle a user editing the same note on three devices while all are offline? (Yjs/Automerge with vector clock per actor ID. Server merges each incoming op.)
- What's the metadata cost of CRDTs on a million-record collection? (Per-entity clock, tombstones for OR-Set removals. compaction becomes a background job, discuss GC of causal history.)

### Junior → FAANG: How To Answer These Questions Without Bluffing

The worst failure mode in a mobile backend interview is claiming knowledge you do not have. Interviewers at senior bar companies are calibrated to detect bluffing, and the signal is unmistakable: a candidate who confidently describes CRDTs in general terms but cannot walk through how a PN-Counter merge actually works is flagged as a no-hire even if the rest of the loop went well. The correct move is to say what you know, say what you do not know, and describe how you would learn the part you do not know. That reads as senior-track honesty, not weakness.

Worked example of honest framing. If asked "how would you design push notifications," a candidate who has only used FCM can say: "I have shipped FCM end to end including token lifecycle and error handling for stale tokens. I know APNs requires HTTP/2 and JWT-based auth with a .p8 key, but I have not personally debugged an APNs production incident, so if we were rolling out iOS I would want to pair with someone who has for the first production push or set up a thorough staging soak." That answer passes a senior loop. The alternative, claiming equal expertise in both, fails when the follow-up asks for a specific APNs error code and its remediation.

Entry-point framing for each question category. BFF design: lead with "what are the screens, what downstreams do they need, what is the target p95 on the worst network we support." Push: lead with "push is best-effort, the server state is authoritative, and token lifecycle is where most teams bleed." Sync: lead with "conflict strategy is per record type, LWW for the simple case, CRDT for collaborative state, and I will ask about the data characteristics before committing." These opening moves signal that you have the senior mental model before you say anything specific.

### Senior @ FAANG: The Questions Behind The Questions

Each question above is also a question about architectural judgment, not just technical recall. The interviewer is probing whether you can navigate the decision, not just execute a known pattern. A staff-level signal per question.

On the 2G design question, the behind-the-question is "do you prioritize round-trip elimination over payload optimization." A candidate who jumps to "I would use protobuf and compression" without first saying "I would aggregate into a BFF to eliminate round trips, then measure what remains" is operating at a mid-level. The same applies to HTTP/3: mentioning connection migration and 0-RTT resumption as first-order benefits, with the caveat that QUIC at the edge is easier than QUIC origin-to-edge, signals staff-level operational awareness.

On the push token lifecycle question, the behind-the-question is "do you understand that push is best-effort and design around that, or do you still treat it as a message bus." The staff-track signal is mentioning that client-reported receipt is the lower bound on delivery, that provider 200 OK is acceptance not delivery, and that the incident-response playbook distinguishes provider failure from token lifecycle failure from fan-out service failure. Bonus points for mentioning push provider redundancy (APNs plus FCM plus WebPush for web-installed PWAs) as an ADR item.

On the sync conflict question, the behind-the-question is "can you write the sync engine selection ADR." A candidate who names five conflict strategies is competent. A candidate who then says "I would pick per record type, justify each choice against the product's data characteristics, and document the reversal cost since sync engine choice ships to every installed client" is staff-track. Follow-up on managed sync engines (Replicache, PowerSync, ElectricSQL, Turso embedded replicas) signals awareness of the 2026 landscape beyond what was available in 2020.

Expect additional questions at staff loops that are not on this page. "Walk me through how you would ship a breaking API change to 100 million installed clients without breaking anyone." "Your push fan-out service is delayed by 45 minutes due to an outage. The backlog is a billion notifications. How do you drain it?" "A regulator has asked for all data about user X to be deleted from your pipeline. Describe the end-to-end process and SLA." "Your sync engine produces 2% conflict rate on a new feature. Is that healthy? What would you do?" Each of these is a test of judgment and of awareness that the mobile backend is a portfolio of decisions, not a single system.

---
