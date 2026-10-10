## Common Mistakes

| Mistake | Problem | Solution |
|---------|---------|----------|
| Multiple round trips for one screen | High latency on mobile networks | BFF: aggregate data in one endpoint |
| Large uncompressed responses | Battery/data drain | Enable gzip. Minimize payload size |
| Offset pagination | Inconsistent results during scrolling | Use cursor-based pagination |
| Not handling stale APNs tokens | Silent push failures | Clean up `Unregistered` errors immediately |
| Session not tied to device | Can't remotely revoke specific device | Bind JWT to the server-assigned device ID (`did` claim), not the forgeable fingerprint |
| No offline-first strategy | App broken on poor network | Design sync protocol from the start |
| Sending events one-by-one | Massive overhead per event | Batch events client-side. Send every 30s |
| Not compressing analytics batches | Analytics is high-volume | Always gzip analytics payloads |
| Token rotation on every request | Breaks concurrent requests | Rotate only on 401. Use token lock |
| Trusting `ClientTime` in sync without bounds | Client with wrong clock dominates LWW | Reject timestamps beyond `server_time ± 5min`, substitute server time |
| Hard-deleting push tokens on `Unregistered` | No audit trail when users complain | Move to `tokens_archived` with reason and timestamp |
| Removing API fields on a schedule | Breaks old clients still in the wild | Drive removal from read-traffic metrics, not calendar |
| Silent merge on collaborative records | Users report data loss | Escalate from LWW to CRDT or explicit conflict UI for the record class |
| Bearer tokens for high-risk mobile flows | Stolen token gives multi-month foothold | Bind tokens to device via DPoP or platform attestation |
| Collecting events without schema registry | PII leaks impossible to audit or delete | Gate ingest on registered schema with PII classification |
| Full resync on reconnect | Battery and data-plan violation | Cursor-based delta sync with opaque monotonic cursor |
| One BFF for all clients at 500+ engineers | Coordination bottleneck on every screen change | Federated GraphQL with per-domain subgraphs or per-client BFF |
| Push as reliable delivery channel | Missing messages when push dropped | Push is a wake-up hint only, server state is authoritative |
| Ignoring iOS ATT and DMA in event design | Regulatory exposure at EU scale | Capture consent state as event field, enforce at processor tier |

### Junior → FAANG: Reading The Mistakes Table As A Maturity Ladder

This table is not a checklist of things to avoid. It is a maturity ladder. The mistakes at the top (multiple round trips, large responses) are junior-level and get caught in code review. The mistakes in the middle (session binding, token rotation) are mid-level and get caught by a security reviewer. The mistakes at the bottom (schema governance, regulatory exposure, BFF ownership model) are staff-level and get caught only by an ADR review or, worse, by a production incident or a regulator. When reading this table, ask yourself which tier of mistake you have personally seen happen and which tier you have personally prevented. The gap between those two tiers is your next growth area.

Worked example for self-assessment. A new grad should be able to explain why "multiple round trips" is a problem on cellular and to spot the pattern in a code review. An L4 engineer should be able to explain why "hard-deleting push tokens" removes the audit trail you need for postmortems. An L5 engineer should be able to write the ADR that selects LWW versus CRDT for a new collaborative feature. An L6 engineer should be able to defend the entire mobile backend portfolio's mistake-prevention posture to a VP during an incident review.

### Senior @ FAANG: The Mistakes That Do Not Fit In A Table

The table above captures mistakes that have a clear right answer. The mistakes that end careers or cost the company seven figures do not fit in a table because the right answer is context-dependent. A partial list for staff-level awareness.

Choosing a sync engine because a senior engineer on the team likes it, without writing an ADR that compares alternatives against the product's actual data characteristics. Reversal cost is measured in years and engineer-decades.

Shipping a feature flag system that does not sync to offline clients, so a flag flip silently fails to reach a subset of users. The debug loop is measured in weeks because nobody reproduces the issue in the office.

Standardizing on a push provider without a redundancy plan, and then the provider has a multi-hour outage during a product-critical moment (Super Bowl ad, product launch, earnings announcement). The retrospective is brutal.

Accepting analytics events without a schema registry because "we will add governance later." Later arrives as a regulatory request and the cost of retroactive governance is one to two orders of magnitude higher than upfront governance.

Writing a BFF in a language different from the downstream services without a deliberate decision. Every cross-service call incurs serialization cost and type duplication. Over three years this cost compounds into a team-wide tax nobody wants to pay down because fixing it requires rewriting the BFF, which nobody has budget for.

Conflating session timeout and refresh token lifetime. A 30-day refresh token with no theft detection gives an attacker a month of access. A 15-minute access token with a 1-year refresh token and no rotation gives the same attacker a year of access through silent refresh. The right design is short access tokens, rotated refresh tokens, device-bound proof of possession, and theft detection, all four, not a subset.

Designing for the median user. The mobile user at the 95th percentile of latency, the 99th percentile of payload, or the 99.9th percentile of connectivity disruption is where your architecture is actually tested. Optimizing for the median produces a system that works in the office and fails in the field. Staff-level design instruments and defends the tail, not the mean.

Each of these is the kind of mistake that does not show up in a code review and does show up in an incident retrospective. The job at staff level is to make the invisible mistakes visible before they become incidents.
