## Key Design Decisions

### Decision 1: Redis GEO for Driver Locations (vs. PostGIS / Elasticsearch)

**Choice:** Redis GEO sorted sets for live driver positions.

**Why Redis:** Drivers update every 4 seconds, so 1.25M writes/sec. Redis handles this in-memory with O(log N) writes, since GEOADD is a ZADD against a sorted set of geohash scores. PostGIS on disk cannot sustain this write rate.

**On read cost:** `GEOSEARCH` (which replaced the deprecated `GEORADIUS` in Redis 6.2) is O(N+log M), not O(log N). N is the number of members inside the bounding area and M is the total set size, so the search visits every driver in the covered geohash ranges and then filters by exact distance. This is fast because N is small once you shard the key by region, not because the algorithm is logarithmic. Keep a region's key to 500K-1M drivers and a 3km search touches hundreds of members, returning in single-digit milliseconds. Let one key grow global and the same query degrades linearly, which is the failure mode people miss when they read "O(log N)" and stop.

**Trade-off:** Redis GEO is eventually consistent (a driver's position lags by up to 4s). Acceptable for matching but not for legal evidence. PostgreSQL stores the authoritative trip log.

**Production optimization:** Use Redis Cluster, partition `drivers:geo` by region prefix (e.g., `drivers:geo:us-west`). Each region cluster handles 500K-1M drivers.

---

### Decision 2: H3 Hexagonal Grid for Surge Pricing (vs. Square Grid / City-Level)

**Choice:** Uber's open-source H3 library at resolution 9, whose cells average about 0.105 km² (roughly 105,000 m²) in area, with an edge length around 200m.

Be careful with these two numbers, because mixing them up is a common and expensive mistake. The ~200m figure is a length, not an area and not a radius. Reading "resolution 9 is 200m" as "200 square meters" undersizes the cell by a factor of five hundred, and a surge engine built on that belief would expect a handful of requests per cell where it should expect hundreds, putting every band threshold in the wrong place. When a spec quotes a single distance for a hexagon, always ask which distance it means.

One more trap worth knowing: you will find the figure 174m widely quoted for resolution 9 edge length. That number comes from H3's 3.x documentation table, which used a different definition. Ask the v4 library and it reports `HexagonEdgeLengthAvgM(9)` as 200.8m, and measuring an actual cell's boundary in San Francisco gives ~205m per edge. The lesson generalizes past H3: when a constant matters, get it from the library you are actually calling rather than from a blog post or an old doc table, because both of those can be right about a version you are not running.

**Why hexagons:** Every neighbor of a hexagon sits at the same center-to-center distance, so there is no diagonal versus orthogonal distortion of the kind square grids suffer, where diagonal neighbors are 1.41x farther than orthogonal ones. This makes the demand/supply ratio comparable across adjacent cells and makes "expand to the neighboring cells" a uniform operation.

**Why resolution 9:** Large enough to aggregate a meaningful demand signal (a neighborhood generates enough requests per minute for the ratio to be more than noise), small enough to capture hyper-local supply shortages such as a stadium letting out. Coarser and a surging block gets averaged away against the quiet ones around it. Finer and each cell holds too few requests for the ratio to mean anything, so the multiplier jitters on random arrivals.

**Trade-off:** More complex to implement than lat/lng buckets. But H3 is Uber's own library, released as open source, so `uber/h3-go` makes this straightforward.

---

### Decision 3: Trip State Machine with Event Publication (vs. Direct Updates)

**Choice:** Validated state transitions written to `trips` and published to Kafka, with downstream services consuming the events.

Worth naming precisely: this is event-driven, not event sourcing. The `trips` row holds current state and is the source of truth, and events announce that state changed. In true event sourcing the event log is the source of truth and current state is a projection you can rebuild by replaying it. The distinction matters when someone asks you to recover from a bad deploy. Here, the trips table is what you restore, and the events are a stream you can replay to rebuild consumers. Calling this event sourcing in an interview invites a follow-up you cannot answer.

**Why events:** Notification service, earnings service, analytics, and fraud detection all need trip state changes. Event-driven decouples these consumers, so adding a new one does not require modifying the trip service.

**Trade-off:** Eventual consistency between trip service and consumers. Notifications may lag 100-500ms. Acceptable given trip transitions happen at human timescales (minutes).

**Failure handling:** Kafka guarantees at-least-once delivery. Consumers use idempotency keys (trip_id + status) to deduplicate.

---

### Decision 4: Multi-Factor Driver Scoring (vs. Nearest-Driver-First)

**Choice:** Weighted composite: 60% ETA, 20% rating, 20% reliability.

**Why not nearest-first:** The nearest driver may have a weak rating and a low acceptance rate, and sending requests they will reject wastes the rider's time twice: once waiting for the offer to time out, once waiting for the next driver. The composite score sends the request to the driver most likely to accept quickly, which is not always the closest one.

**Acceptance rate penalty:** Drivers who cherry-pick (accepting only long, high-fare trips) drop in score. The right measure of this change is not raw match rate but time-to-match at the same driver supply, and the only credible way to establish the gain is an A/B test in the market you are tuning for.

**Trade-off:** Scoring requires routing API calls (20 parallel requests per match). Cached traffic matrices for short distances keep P99 latency under 300ms.

---

### Decision 5: Idempotent Payment Processing

**Choice:** Use `tripID` as Stripe idempotency key. Store payment record before API call.

**Why:** Network failures between the platform and Stripe are real, and a timeout tells you nothing about whether the charge went through. Without idempotency, the retry double-charges. Stripe's idempotency keys deduplicate on their end, and the local payment record lets the service detect already-processed payments without a round trip.

**The catch:** an idempotency key only protects you when the retry sends identical parameters. Replay the same key with a different amount and Stripe returns a 400, not the original charge. This turns a re-pricing between attempts into a hard failure, which is why the retry reads the stored amount back from the payment row rather than recomputing the fare.

**Trade-off:** Requires two DB writes per payment (create pending, then update succeeded). Easily affordable, since payments run at one per trip while locations run at 1.25M/sec.

---

### Decision 6: WebSocket for Real-Time Location Streaming

**Choice:** Persistent WebSocket connections for driver→server location updates and server→rider position streaming.

**Why WebSocket vs. HTTP polling:** A driver's location update is roughly 64 bytes of payload. Sent over a fresh HTTP request it carries several hundred bytes of headers plus a TLS handshake, so the overhead dwarfs the data. Multiply by 1.25M updates/sec and the framing, not the GPS, becomes the bandwidth bill. A WebSocket pays the handshake once per connection and then frames each update in a couple of bytes. Polling in the other direction is worse still, because a rider polling for a driver's position mostly retrieves nothing while still paying full request cost.

**Scaling:** 8M WebSocket connections ÷ 40K connections/server = 200 gateway servers. Gateway servers are stateless (connection state in Redis). Driver connects to nearest edge node via anycast DNS.

---
