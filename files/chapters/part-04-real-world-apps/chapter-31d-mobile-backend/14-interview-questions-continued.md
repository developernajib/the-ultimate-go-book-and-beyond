## Interview Questions (Continued)

**Q: How do you handle API versioning when you can't force mobile app updates?**

A: Adopt an additive-change policy: never remove or rename fields, only add new ones. Version by URL prefix (`/api/v2/`) for clear routing. Maintain the last two major versions simultaneously. Use the `Deprecation` and `Sunset` response headers to signal to the app that it is running on an old API, so engineering dashboards can surface which users need to upgrade. For emergency breaking changes (security patches), add a minimum-version enforcement endpoint that the app checks on launch and redirects users to the App Store/Play Store when their version falls below the floor. For binary contracts (protobuf), never reuse field numbers and never change a field's type, mark fields `reserved` when retiring them.

**What FAANG expects:** You acknowledge that a non-trivial tail of users (5-15%) will run an app version you shipped 18+ months ago because they never update, and your answer accounts for that reality. A purely additive JSON policy, explicit sunset headers, and a kill-switch for security-forced upgrades are table stakes. The senior signal is recognizing that *retiring* an API version is a year-long process with phased alerts, not a flip of a flag.

Follow-ups they'll probe:
- How do you get telemetry on which app versions are hitting each endpoint? (Log `User-Agent` / `X-App-Version` on every request. Dashboard the long tail.)
- What's your fallback when a v1 client hits a v2-only endpoint? (Return a semantic error with an `upgrade_required` error code and a Store link, never a 404.)
- How do feature flags interact with versioning? (Flags gate behavior *within* a version. Version gates wire format. Don't mix the two.)

---

**Q: How would you design an offline-first notes app backend?**

A: (1) Each note has `id` (UUID), `user_id`, `content`, `updated_at` (server-assigned), `deleted_at` (nullable), and a `vector_clock` column for concurrency detection. (2) The sync endpoint accepts a batch upload of client changes and returns all server changes since `last_sync_at` in a single round trip. (3) Conflict policy: last-write-wins by server `updated_at` for solo use. For collaborative notes, use a CRDT-backed text type (Yjs/Automerge) so concurrent edits merge without loss. (4) Tombstones: soft-delete with `deleted_at`. Purge tombstones after 90 days (with a forced full-sync for older clients to avoid resurrection bugs). (5) Encryption: note `content` is encrypted at rest using per-user keys derived via HKDF from a KMS root key. The server never sees plaintext. (6) Sync tokens are server-issued monotonic timestamps, not client clocks, to eliminate clock-skew drift. (7) Delta payloads include a `server_time` that the client persists as the next `last_sync_at`.

**What FAANG expects:** A complete answer ties the data model to the conflict strategy to the wire format. "Encrypted at rest" is not enough, they want to hear the key hierarchy (envelope encryption with KMS), the tombstone purge schedule (and why it forces a full sync for stragglers), and the failure modes of each choice.

Follow-ups they'll probe:
- How does search work when the server can't read plaintext? (Client-side search index, or blind-indexed ciphertext, trade-off: zero-knowledge vs query capability.)
- What breaks when a device's clock is two years wrong? (Client `updated_at` becomes useless as a tiebreaker. vector clocks or server-issued sequence numbers survive.)
- How do you migrate from LWW to CRDT without data loss? (Shadow-write both, diff merge results, switch reads when divergence is below threshold.)

---

**Q: How does Instagram handle image upload and processing for mobile?**

A: (1) Client requests a presigned S3 URL from the API server. (2) Client uploads the raw image directly to S3 (bypassing the API server - avoids doubling bandwidth and freeing app servers from binary work). (3) S3 triggers a Lambda/worker that processes the image: resizes to multiple resolutions (thumbnail, feed, full), strips EXIF metadata, converts to AVIF/WebP. (4) Worker writes the processed URLs to the database and publishes a Kafka event. (5) The feed service enriches posts with CDN URLs. (6) CDN serves images from edge PoPs closest to the user, with `Accept`-driven format negotiation (AVIF → WebP → JPEG fallback). Key insight: keep the API server out of the binary upload path entirely.

**What FAANG expects:** You identify the *architectural goal*, decouple binary data from the request path, and you cite concrete consequences (scalability, cost, isolation of slow work). They also want to hear about failure modes: what if S3 accepts the upload but the worker crashes? (S3 event is durable and retried. Idempotency on the notification consumer.)

Follow-ups they'll probe:
- How do you prevent a malicious client from uploading a 1 GB "image"? (Presigned URL with `Content-Length` bound and `Content-Type` allowlist. defense-in-depth validator at the worker.)
- What about EXIF GPS data? (Strip unconditionally server-side. Never trust the client to sanitise its own metadata.)
- How does the client show the image before the worker finishes? (Optimistic placeholder from a blurhash computed on upload. Swap to CDN URL when the worker's Kafka event arrives via push/polling.)

---

**Q: How do you handle mobile rate limiting with intermittent connectivity?**

A: Standard rate limiting punishes reconnecting clients unfairly - a device offline for an hour reconnects and fires 200 queued requests. Use a **token bucket** with burst allowance (e.g., 200 burst / 60 req-per-minute sustained) rather than a fixed window. Tag rate limit buckets to the authenticated user + server-assigned `device_id`, not the IP (mobile IPs rotate on carrier NAT, and many users share a carrier-grade NAT egress IP). Return `Retry-After` in 429 responses so the client backs off intelligently. For analytics/batch endpoints, exempt them from per-request limits but enforce per-payload size limits instead (e.g., max 500 events per batch, max 1 MB compressed).

**What FAANG expects:** You distinguish the policy (token bucket vs sliding window vs leaky bucket) from the *keying strategy*, and the keying strategy is where most implementations get it wrong on mobile. Keying on IP punishes legitimate users and fails to stop botnets. keying on device identity requires an authenticated session, which chicken-and-eggs the login endpoint. They want to hear a layered answer: unauthenticated endpoints key on IP + `User-Agent` fingerprint with a loose cap, authenticated endpoints key on user+device with a tight cap.

Follow-ups they'll probe:
- How do you rate-limit the login endpoint itself? (Per-IP sliding window + per-username token bucket + CAPTCHA on failure streaks.)
- What happens when Redis (your rate-limit store) is down? (Fail *open* with lowered caps in a local in-memory bucket, failing closed locks every user out.)
- How do you distribute the token bucket across 50 API replicas? (Lua script on Redis for atomicity, or an approximate algorithm like sharded counters with periodic reconciliation.)

---

**Q: How do you implement JWT refresh token rotation for mobile apps?**

A: Issue a short-lived access token (15 min) and a long-lived refresh token (30 days), both bound to a `device_id`. On 401, the mobile client calls `/auth/refresh` with the refresh token. The server: (1) verifies the token signature and expiry, (2) checks it has not been revoked in the token store (Redis key: `refresh:{jti}`), (3) issues a new access token and a new refresh token, (4) marks the old refresh token as used. If the old refresh token is presented again after rotation (replay attack), immediately revoke the entire device session - this signals token theft. Use a mutex or distributed lock to prevent race conditions when the app fires concurrent requests that all trigger a 401 simultaneously (only the first refresh wins. Others retry with the new access token).

**What FAANG expects:** Rotation + reuse detection is the senior-level signal. Anyone can describe issuing tokens. FAANG wants the replay-detection state machine (old-token-seen-after-rotation ⇒ nuke the session family) and the concurrency handling (thundering herd of 401s from a tab-heavy app). They'll also want the client-side contract: a single-flight refresh coordinator so only one refresh call is in flight per process.

Follow-ups they'll probe:
- Where do you store the refresh token on iOS/Android? (Keychain / EncryptedSharedPreferences, never in plain `UserDefaults` / `SharedPreferences`.)
- How do you log out a user across every device they own? (Revoke the `user_id`'s token family via an `iat_cutoff` in the user row. Any token with `iat < cutoff` is rejected.)
- What's the blast radius of a leaked signing key? (Every unexpired access token is forgeable, rotate keys via a JWKS endpoint with overlapping `kid`s so rotation is zero-downtime.)

---

**Q: How do you debug mobile app issues from the backend side?**

A: (1) Correlation IDs: every API response includes an `X-Request-ID` header. The mobile app logs it alongside client-side errors so you can cross-reference server logs. (2) Structured logging: log `device_id`, `app_version`, `os_version`, and `user_id` on every request for precise filtering. (3) Error response codes: return machine-readable error codes (`"error_code": "TOKEN_EXPIRED"`) not just HTTP status codes, so the client can handle errors programmatically and you can query error frequencies in Datadog/Grafana. (4) SDK-level diagnostics endpoint: `/api/v1/diagnostics/echo` reflects back the parsed request headers so QA can verify the client is sending correct auth and content-type headers. (5) Feature flags: gate new behavior behind flags so you can disable a broken feature server-side without an app release. (6) Distributed tracing: propagate W3C `traceparent` from the client through the BFF into downstream services so you can see the full fan-out for a single user tap.

**What FAANG expects:** You treat mobile debugging as a *bidirectional* telemetry problem. The server cannot see what the client did, and the client cannot see what the server did, so you must correlate both sides through a shared ID. Structured logging with high-cardinality fields (`user_id`, `device_id`) is assumed. The interesting signal is how you query it without exploding costs (sampling, short retention for high-cardinality, aggregation for long-term).

Follow-ups they'll probe:
- How do you debug a bug that only happens on one user's device? (Correlation ID lookup. Remote log upload on crash via the mobile SDK. Feature-flag a verbose-logging mode for that user.)
- How do you handle PII in logs? (Redact at ingestion with a policy layer, hash user IDs with a per-env pepper for joinability without exposure.)
- What's your SLO for time-to-diagnosis on a P1 mobile bug? (Usually 1 hour for triage. Traces + logs must be queryable by release + device-tier within that window.)

---

**Q: How do you guarantee push notification delivery?**

A: You cannot guarantee delivery - APNs and FCM are best-effort. What you can do: (1) **Delivery tracking**: store a `notification_send_log` row with `status=pending` before sending. Update to `delivered` or `failed` based on the gateway response. (2) **Silent push + polling fallback**: send a silent push (`content-available: 1` on iOS, high-priority data message on Android) that triggers the app to poll a `/notifications/pending` endpoint. The polling response is the reliable fallback. (3) **Inbox model**: store unread notifications server-side. The app fetches them on every foreground transition. This ensures the user sees the notification even if the push was dropped. (4) **Retry with exponential backoff** for transient gateway errors (5xx from APNs/FCM). Do not retry permanent errors (invalid token). (5) **Deduplication**: include a stable `notification_id` in the payload so the client discards duplicates if both the push and the polling path deliver the same message.

**What FAANG expects:** The opening sentence, "you cannot guarantee delivery", is the answer they're testing for. Anyone who claims push is reliable fails this question. The senior answer reframes the problem: *delivery is best-effort, but user visibility is a hard requirement*, and the inbox model is how you close that gap. Bonus points for mentioning that iOS will drop notifications from a "misbehaving" app (too many silent pushes per day) and the Low Data Mode / Focus restrictions that the OS imposes outside your control.

Follow-ups they'll probe:
- What's your p99 push latency budget, and where does it come from? (End-to-end: business event → router → gateway accept → device wake. Gateway latency is the long tail you can't optimize.)
- How do you test push delivery end-to-end in CI? (Simulator with a fake APNs/FCM gateway. Testflight builds with a delivery-ack round-trip over a back-channel.)
- What about Huawei HMS / push in China? (Separate push pipeline, MIUI, Xiaomi, Huawei Push Kit, behind the same abstraction as APNs/FCM.)

### Junior → FAANG: Using These Questions As A Mock-Interview Set

Each of these questions is close to verbatim what senior loops ask, minus the specific product details that make them company-specific. Practice answering them aloud. Time yourself. A complete answer should take two to four minutes, not thirty seconds and not ten minutes. The right cadence: one sentence of framing ("this is a best-effort problem, here is the invariant I am defending"), two to three concrete mechanisms, one failure mode you are designing against, and one follow-up you expect the interviewer to ask. If you find yourself running long, you are not yet distilled. Practice until the answer fits in the budget.

Worked framing for the API versioning question. "Mobile apps cannot be force-updated, so the invariant is additive evolution. I never remove or rename fields. I version major shapes via URL prefix and gate per-endpoint deprecation via response headers. I instrument field-level read traffic so deprecation is data-driven, not calendar-driven. The failure mode I design against is an emergency breaking change for security, which requires a kill-switch and a forced-update floor. I would expect a follow-up about how I ratchet the floor without stranding users." That is a 45-second answer that covers the senior-track signal in every dimension.

Entry-point framing for junior candidates. If you have not shipped a production mobile backend, the honest opening is: "I have not personally owned this end to end. Here is what I know from reading and smaller projects, and here is where I would expect to pair with a senior engineer on my first production rollout." That answer is better than bluffing and is frequently a pass signal because the interviewer now knows what to probe and what to coach.

### Senior @ FAANG: Reading Between The Lines Of These Questions

At staff level these questions are probes for a portfolio of decisions, not individual technical knowledge. The interviewer is checking whether you can navigate the decision tree, whether you have calibrated taste, and whether you know where the sharp edges are. A staff-level reading of each question.

On versioning, the question behind the question is whether you understand that mobile API evolution is a governance problem, not a technical problem. The right answer includes the schema registry, the field-level usage instrumentation, the deprecation workflow, and the forced-update floor policy. Missing any of these is a mid-level answer.

On the notes app design, the question is whether you can integrate data model, conflict policy, wire format, encryption, and operational concerns into one coherent architecture. The staff-level addition that the canned answer omits: the observability story (how do you know the sync engine is working correctly across the installed base, what are the leading indicators of a problem, how do you roll back a bad sync engine change that is already on a hundred million devices), the migration story (how do you move from LWW to CRDT for a record type without data loss), and the cost story (tombstone retention and CRDT metadata are real storage costs at scale).

On image upload, the question is whether you understand that keeping binary out of the API path is not an optimization but an architectural requirement. Bonus points for mentioning the multipart-upload story for large images (chunked resumable upload via S3 multipart, important for slow cellular uploads), the virus-scan requirement for user-uploaded content (gate the publish step on scanner result), and the content-moderation pipeline for images that may be policy violations (a scanner pipeline that feeds a moderation queue, with a server-side flag that hides flagged images until review).

On rate limiting, the question is whether you understand that keying is the architecture and the algorithm is the implementation detail. The staff-level addition: the layered rate limiter with a local-in-process first tier (microsecond latency, approximate), a regional Redis second tier (millisecond latency, exact within region), and a global third tier for the few endpoints that need global bounds (login, signup, password reset). Most endpoints stop at the first or second tier.

On refresh token rotation, the question is whether you know the reuse-detection state machine and understand that token theft is detectable via this mechanism. Additional staff-level signal: the DPoP proof-of-possession upgrade (bind the token to a device-held key, so a stolen token without the key is useless), the device attestation step on high-risk flows (re-authenticate the device via App Attest or Play Integrity before accepting a token for a sensitive action), and the single-flight refresh coordinator on the client side (multiple concurrent 401s trigger one refresh, not many).

On mobile debugging, the question is whether you have ever been on-call for a mobile incident. The staff-level signal is the incident-response playbook: how do you triage, who do you page, what dashboards do you look at first, how do you distinguish client-side failure from server-side failure from provider-side failure, and how do you roll back a bad server change versus how do you roll back a bad client change (the second is much harder because client rollback requires either a force-update or a server-side flag that disables the buggy client behavior). Mentioning that client rollback is the harder problem is the senior-track insight.

On push delivery, the question is whether you know that delivery is not a guarantee and visibility is the real requirement. The staff-level addition: the inbox model as the convergence layer between push-as-wake-up and polling-as-fallback, the client-reported receipt metric as the headline dashboard, and the push-storm runbooks for the three storm scenarios (product launch, outage recovery, feedback loop from a bad client version). Also: the regional push providers. On China-market Android, where Google Play Services is absent, you must integrate the OEM push systems directly (Huawei Push Kit, plus Xiaomi, OPPO, and vivo push) rather than relying on FCM. The staff-level answer names this regional fragmentation as a design constraint, not an afterthought.

The meta-signal across all these questions is whether you talk like an engineer who has owned the system, or like an engineer who has read about the system. Ownership shows up in specific numbers (p99 push latency budget, typical token TTL, typical sync gap threshold), in specific failure modes (the bug that bit you last quarter), and in explicit trade-offs (we chose X over Y because of Z, and here is what Z costs us). Reading-only shows up in generic answers without numbers, without bugs, and without trade-offs. The interviewers are trained to distinguish.

---
