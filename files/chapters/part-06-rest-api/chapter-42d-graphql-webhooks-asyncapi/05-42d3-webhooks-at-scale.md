## 42D.3 Webhooks at Scale

### What Are Webhooks?

Webhooks are "reverse APIs" - instead of the client polling for changes, the server pushes events to a client-provided URL.

```
Traditional Polling:
Client → GET /orders/123/status   (every 5s, 99% return "no change")

Webhooks:
Server → POST https://client.com/webhooks/orders  (only when status changes)
```

### Delivery Guarantees

Webhooks use **at-least-once** delivery: the same event might be delivered more than once (idempotency key required), but events are never silently dropped.

### The Emerging Standard: standard-webhooks.com

Every large webhook producer (Stripe, GitHub, Shopify, Slack) ships its own signature header format, its own retry schedule, and its own replay semantics, which forces every SaaS integration to implement webhook verification N times. The Standard Webhooks spec (standardwebhooks.com, authored by the Svix team and adopted by several large producers) canonicalizes this:

- Headers: `webhook-id` (unique event ID for dedup), `webhook-timestamp` (unix seconds), `webhook-signature` (space-separated list of `v1,<base64-hmac-sha256>` entries to support key rotation).
- Signed content: `${webhook-id}.${webhook-timestamp}.${body}`, binding the ID, timestamp, and body together in a single HMAC.
- Multiple signatures per delivery: supports zero-downtime signing-key rotation. Receivers accept any valid entry.

Build new webhook APIs on this spec where possible, and match Stripe's format when you already ship on Stripe-style headers. The code below uses Standard Webhooks signing conventions with custom header names for clarity. Swap them for `webhook-id`/`webhook-timestamp`/`webhook-signature` to be spec-compliant.

### Build It or Buy It: Svix

Running a webhook platform well (retries, DLQ, rotating signing keys, per-tenant dashboards, replay UI, rate limiting by endpoint) is weeks of infrastructure work your product team will keep adding to for years. Svix (svix.com) is the managed equivalent, it's what Clerk, Resend, Lob, and several Y Combinator companies use instead of building in-house. The tradeoff: you outsource delivery but own the event model. Build in-house when your delivery semantics are exotic (batching, ordering guarantees, sub-second latency), the event stream is enormous enough that per-event pricing hurts, or webhook delivery is a core product feature. Otherwise buy.

```go
// Webhook payload design
type WebhookPayload struct {
	ID         string          `json:"id"`          // Unique event ID (use for dedup)
	Type       string          `json:"type"`        // "order.created", "payment.failed"
	CreatedAt  time.Time       `json:"created_at"`
	APIVersion string          `json:"api_version"` // "2026-01-01"
	Data       json.RawMessage `json:"data"`
}

// WebhookSender delivers webhooks with HMAC-SHA256 signatures
type WebhookSender struct {
	client     *http.Client
	signingKey []byte
	metrics    *WebhookMetrics
}

func NewWebhookSender(signingKey []byte) *WebhookSender {
	return &WebhookSender{
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		signingKey: signingKey,
		metrics:    newWebhookMetrics(),
	}
}

// Send delivers a webhook with HMAC-SHA256 signature
func (s *WebhookSender) Send(ctx context.Context, endpoint string, payload WebhookPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshaling payload: %w", err)
	}

	// Sign id.timestamp.body together (Standard Webhooks / Stripe-style).
	// Signing the body alone would let an attacker replay the same body with a fresh timestamp.
	ts := strconv.FormatInt(payload.CreatedAt.Unix(), 10)
	signedContent := payload.ID + "." + ts + "." + string(body)
	signature := s.sign([]byte(signedContent))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Webhook-ID", payload.ID)
	req.Header.Set("X-Webhook-Timestamp", ts)
	// "v1,<base64>" matches the Standard Webhooks / Svix format - multiple entries
	// can be space-separated during signing-key rotation.
	req.Header.Set("X-Webhook-Signature", "v1,"+signature)

	resp, err := s.client.Do(req)
	if err != nil {
		return &WebhookError{Err: err, Retriable: true}
	}
	defer resp.Body.Close()

	s.metrics.RecordDelivery(endpoint, resp.StatusCode)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}

	// 4xx (except 429) = permanent failure, don't retry
	if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 429 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return &WebhookError{
			Err:       fmt.Errorf("endpoint returned %d: %s", resp.StatusCode, respBody),
			Retriable: false,
		}
	}

	// 5xx or 429 = transient, retry
	return &WebhookError{
		Err:       fmt.Errorf("endpoint returned %d", resp.StatusCode),
		Retriable: true,
	}
}

func (s *WebhookSender) sign(content []byte) string {
	mac := hmac.New(sha256.New, s.signingKey)
	mac.Write(content)
	// base64 (not hex) to match Standard Webhooks / Svix wire format.
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

type WebhookError struct {
	Err       error
	Retriable bool
}

func (e *WebhookError) Error() string { return e.Err.Error() }
func (e *WebhookError) Unwrap() error { return e.Err }
```

### 42D.3.1 Retry with Exponential Backoff and Full Jitter

`calculateBackoff` multiplies the base wait by `Multiplier^attempt` then applies full jitter by selecting a random value in `[0, computed_wait]`, spreading retries from failed batches across the window rather than synchronizing them. Capping at `MaxWait` prevents the exponential from growing unboundedly, and the `MaxAttempts` limit ensures a webhook is eventually dead-lettered rather than retrying indefinitely.

```go
type RetryPolicy struct {
	MaxAttempts int
	InitialWait time.Duration
	MaxWait     time.Duration
	Multiplier  float64
}

func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		MaxAttempts: 10,
		InitialWait: 5 * time.Second,
		MaxWait:     3 * time.Hour,
		Multiplier:  2.0,
	}
}

// calculateBackoff uses full jitter to prevent a thundering herd when many
// webhooks fail simultaneously (which is the normal case: they usually fail
// together because the receiver went down, not independently).
func (p RetryPolicy) calculateBackoff(attempt int) time.Duration {
	wait := float64(p.InitialWait) * math.Pow(p.Multiplier, float64(attempt))
	if wait > float64(p.MaxWait) {
		wait = float64(p.MaxWait)
	}

	// Full jitter: uniform in [0, cap). NOT cap +/- 25%, which leaves the
	// fleet clustered around cap and roughly doubles the peak retry rate.
	//
	// Consequence to internalise: the cap is a CEILING, not the delay. The
	// mean delay is cap/2, so this schedule is half as slow as the
	// Multiplier suggests. That is intended, and it is why the numbers
	// below are not the numbers you would guess from 5s * 2^n.
	jitter := rand.Float64() * wait

	// Floor it. rand.Float64() returns [0,1), so early attempts can produce
	// sub-millisecond delays: a "retry" 200 microseconds after a connection
	// refused is just a second connection refused. Give the receiver time
	// to have actually changed state.
	const minWait = 1 * time.Second
	return max(time.Duration(jitter), minWait)
}

// DeliveryWorker processes pending webhook deliveries
type DeliveryWorker struct {
	sender  *WebhookSender
	store   DeliveryStore
	policy  RetryPolicy
	dlq     DeadLetterQueue
	logger  *slog.Logger
}

func (w *DeliveryWorker) Run(ctx context.Context) error {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := w.processBatch(ctx); err != nil {
				w.logger.Error("processing webhook batch", "error", err)
			}
		}
	}
}

func (w *DeliveryWorker) processBatch(ctx context.Context) error {
	deliveries, err := w.store.GetPendingDeliveries(ctx, 50)
	if err != nil {
		return err
	}

	for _, d := range deliveries {
		if err := w.processDelivery(ctx, d); err != nil {
			w.logger.Error("delivery failed", "id", d.ID, "error", err)
		}
	}
	return nil
}

func (w *DeliveryWorker) processDelivery(ctx context.Context, d *WebhookDelivery) error {
	event, err := w.store.GetEvent(ctx, d.EventID)
	if err != nil {
		return err
	}

	sendErr := w.sender.Send(ctx, d.Endpoint, event)
	if sendErr == nil {
		return w.store.MarkSuccess(ctx, d.ID)
	}

	var webhookErr *WebhookError
	if errors.As(sendErr, &webhookErr) && !webhookErr.Retriable {
		w.dlq.Enqueue(ctx, d, sendErr)
		return w.store.MarkExhausted(ctx, d.ID, sendErr.Error())
	}

	nextAttempt := d.Attempt + 1
	if nextAttempt >= w.policy.MaxAttempts {
		w.dlq.Enqueue(ctx, d, sendErr)
		return w.store.MarkExhausted(ctx, d.ID, sendErr.Error())
	}

	nextRetry := time.Now().Add(w.policy.calculateBackoff(nextAttempt))
	return w.store.ScheduleRetry(ctx, d.ID, nextAttempt, nextRetry, sendErr.Error())
}
```

### 42D.3.2 Webhook Receiver: Signature Verification

`WebhookReceiver.Verify` checks the timestamp first to reject replayed deliveries before performing any HMAC computation, limiting the window an attacker has to reuse a captured webhook. The signature covers both the timestamp and the body, so altering either the payload or the timestamp invalidates the HMAC, preventing both tampering and replay attacks in a single verification step.

```go
// WebhookReceiver verifies incoming webhooks
type WebhookReceiver struct {
	signingKey []byte
	tolerance  time.Duration // Clock skew tolerance (5 minutes is standard)
}

func (r *WebhookReceiver) Verify(req *http.Request, body []byte) error {
	id := req.Header.Get("X-Webhook-ID")
	tsStr := req.Header.Get("X-Webhook-Timestamp")
	if id == "" || tsStr == "" {
		return errors.New("missing webhook id or timestamp header")
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return errors.New("invalid timestamp header")
	}

	// Reject old timestamps BEFORE HMAC: bounds the replay window and
	// avoids spending CPU on stale payloads during a replay storm.
	eventTime := time.Unix(ts, 0)
	if time.Since(eventTime) > r.tolerance {
		return fmt.Errorf("webhook timestamp too old: %v ago", time.Since(eventTime).Truncate(time.Second))
	}
	// Reject timestamps too far in the future (clock skew, not a legitimate event).
	if time.Until(eventTime) > r.tolerance {
		return errors.New("webhook timestamp too far in future")
	}

	// Signature covers id.timestamp.body. Changing any of the three invalidates it,
	// so an attacker cannot replay an old body with a fresh timestamp.
	signedContent := id + "." + tsStr + "." + string(body)
	mac := hmac.New(sha256.New, r.signingKey)
	mac.Write([]byte(signedContent))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	// Header carries one or more "v1,<sig>" entries (space-separated) to support rotation.
	header := req.Header.Get("X-Webhook-Signature")
	for _, entry := range strings.Fields(header) {
		version, sig, ok := strings.Cut(entry, ",")
		if !ok || version != "v1" {
			continue
		}
		// Constant-time comparison prevents timing attacks.
		if hmac.Equal([]byte(expected), []byte(sig)) {
			return nil
		}
	}
	return errors.New("invalid webhook signature")
}

func (h *WebhookHandler) HandleOrder(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB limit
	if err != nil {
		http.Error(w, "error reading body", http.StatusBadRequest)
		return
	}

	if err := h.receiver.Verify(r, body); err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var payload WebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Idempotency. Note what this is NOT:
	//
	//	if h.store.IsProcessed(ctx, id) { return 200 }
	//	h.processEvent(ctx, payload)
	//	h.store.MarkProcessed(ctx, id)
	//
	// That is check-then-act. Two retries arriving concurrently (which
	// happens routinely: a sender's timeout fires while the first delivery
	// is still in flight) both observe IsProcessed == false, and both
	// process the event. The window is the entire duration of
	// processEvent, so the slower the handler, the wider the race. For a
	// payment webhook, "processed twice" means "shipped twice".
	//
	// Claim the ID first, atomically, and let the database arbitrate. A
	// unique constraint on event_id makes the insert itself the lock:
	// exactly one concurrent caller can succeed.
	claimed, err := h.store.Claim(r.Context(), payload.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !claimed {
		// Someone else owns this event: already done, or in flight right
		// now. Either way, 200 stops the retries.
		w.WriteHeader(http.StatusOK)
		return
	}

	if err := h.processEvent(r.Context(), payload); err != nil {
		// Release the claim so a retry can pick it up. Without this, a
		// transient failure permanently poisons the event: the claim row
		// exists, every retry sees it and returns 200, and the event is
		// never processed by anyone. Silent data loss that looks like
		// success on both sides.
		if relErr := h.store.Release(context.WithoutCancel(r.Context()), payload.ID); relErr != nil {
			h.logger.Error("claim stuck: event will never be retried",
				"event_id", payload.ID, "err", relErr)
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := h.store.MarkProcessed(context.WithoutCancel(r.Context()), payload.ID); err != nil {
		// The side effect already happened. Do NOT return 500: that
		// triggers a redelivery of an event we have in fact processed, and
		// the claim we failed to finalise may not save us. Alert instead.
		h.logger.Error("processed but not marked", "event_id", payload.ID, "err", err)
	}
	w.WriteHeader(http.StatusOK)
}
```

`Claim` is a single atomic operation, which in PostgreSQL is one statement:

```sql
-- Returns a row only if this caller won the race.
INSERT INTO processed_events (event_id, state, claimed_at)
VALUES ($1, 'in_progress', now())
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id;
```

A claim that stays `in_progress` past a threshold means the handler crashed mid-process, so a sweeper should reset those rows. This is the same reasoning as the idempotency-key middleware in Chapter 42B: the durable record must be created **before** the side effect, not after, because a process can die between the two and only one of those orderings is recoverable.

### Junior -> FAANG: Webhook Fundamentals Every Engineer Must Know

Webhooks are the most widely misunderstood API primitive at the junior level. The misunderstanding usually takes one of two forms: either treating webhook endpoints as ordinary REST endpoints that happen to receive POST requests (missing the security model entirely), or over-engineering the receiver with message queues before measuring whether the processing time actually requires async handling.

**The three things every webhook receiver must do.** First, verify the signature before doing anything else. A webhook endpoint without signature verification accepts POST requests from any source, which means attackers can send fabricated events and trigger business logic (for example, a fabricated "payment.succeeded" event that marks an order as paid without actual payment). Second, return a 2xx response quickly (under 5 seconds). The sender's delivery worker is blocking on your response. If your processing takes 30 seconds and times out, the sender retries the delivery, and now you process the same event twice. Return 200 immediately and process asynchronously if the work is slow. Third, implement idempotency using the event ID. At-least-once delivery means you will receive the same event multiple times during retries. Store the event ID in a processed-events table and check it before processing. If the ID is already there, return 200 without re-processing.

**Understanding the retry schedule.** Do the arithmetic rather than trusting the config values, because full jitter makes the schedule behave differently from what the knobs suggest. With `InitialWait: 5s`, `Multiplier: 2.0`, `MaxAttempts: 10`, the delay for attempt *n* is uniform in `[0, 5s * 2^n)`, so the **cap doubles but the mean is half the cap**:

| Attempt | Cap | Mean actual delay |
|---|---|---|
| 0 | 5s | ~2.5s |
| 3 | 40s | ~20s |
| 6 | 5m20s | ~2m40s |
| 9 | 42m40s | ~21m |

Two things fall out of that table which the configuration hides. First, the total expected time across all 10 attempts is about **43 minutes**, not hours. Second, `MaxWait: 3 * time.Hour` is **dead configuration**: the cap at the final attempt is 42m40s, so the ceiling is never reached and could be set to anything above ~43 minutes without changing behaviour. If you intended to keep retrying for hours, you need more attempts or a larger multiplier, and right now you do not have what you think you configured.

This matters for receiver design in a way that inverts the usual advice: if your endpoint is down for two hours, you will **not** get a burst when it returns, because every event will already have exhausted its 10 attempts and been dead-lettered. Your recovery path is the DLQ replay, not the retry queue. Size the retry window against your realistic worst-case outage, and make DLQ replay a tested operation rather than a hypothetical one.

**Timestamp validation before HMAC computation.** The receiver code checks the timestamp before computing the HMAC. This ordering is intentional and important: timestamp validation is O(1), HMAC computation is O(body_size). During a replay attack, an attacker sends thousands of requests with a valid old signature but a stale timestamp. Checking the timestamp first rejects these requests before any HMAC computation, preventing a CPU exhaustion attack.

**Interview entry point:** "Design a webhook delivery system" is a common system design interview question. The key components to cover: event persistence (outbox pattern for durability), signing (HMAC-SHA256 with the signed content including the event ID, timestamp, and body), delivery (HTTP POST with timeout), retry (exponential backoff with jitter and a maximum attempt count), dead-letter queue (for events that exhaust retries), and receiver requirements (signature verification, timestamp validation, idempotency). Missing any of these components is a signal to the interviewer that you have not operated webhook infrastructure in production.

### Senior @ FAANG: Webhook Platform Engineering and Reliability Contracts

**Build vs buy: the Svix decision at FAANG scale.** The section mentions Svix as a managed alternative. The decision matrix for FAANG organizations is more nuanced than it appears. Svix handles the delivery infrastructure (retries, DLQ, signing key rotation, per-tenant dashboards) but the event model (what types exist, what their schemas are, who can subscribe to what) remains the platform team's responsibility regardless. The correct question is not "should we build our own webhook infrastructure" but "what is the marginal cost of building delivery reliability in-house given that we must build the event model either way?" At FAANG scale, the answer often favors in-house because: the event volume (millions per day) makes per-event managed service pricing expensive, the delivery semantics may need to be customized (ordered delivery for certain event types, batching for high-volume subscribers), and webhook delivery is a core product reliability signal that the organization wants full observability over.

**Signing key rotation as a zero-downtime operation.** Key rotation is a governance requirement, not an optional feature. Signing keys used in production must be rotatable on a schedule (typically every 90 days) and immediately on suspected compromise. The Standard Webhooks multiple-signature model (space-separated `v1,<base64>` entries in the signature header) enables this by publishing both the old and new signatures during the rotation window. The rotation protocol is: (1) generate a new key and add it to the active key set, (2) update the sender to include both old and new signatures in every delivery, (3) notify subscribers that a new key is available and to update their receiver configuration within the rotation window (typically 7 days), (4) after the rotation window, remove the old key from the active key set. The platform must enforce that subscribers who have not updated their configuration during the window receive clear error signals rather than silent delivery failures.

**Dead-letter queue as an observability primitive.** A DLQ is not just a safety net for failed deliveries. It is a diagnostic signal about subscriber reliability. At FAANG scale, monitoring the DLQ depth per subscriber endpoint reveals which integrations are systematically failing and why. The failure mode distribution matters: 4xx failures (permanent, bad receiver configuration) are distinguished from 5xx failures (transient, receiver overloaded or down) and timeout failures (receiver too slow to process). A platform team providing webhook delivery must surface per-subscriber delivery success rates, failure type distributions, and DLQ depths in a dashboard that both the platform team and individual product teams can access. This observability is what makes SLA conversations concrete: you can show a subscriber that their endpoint had a 98.7% delivery success rate last month and that 1.3% landed in DLQ due to 5xx responses from their server.

**Idempotency key design at scale.** The idempotency store (processed event IDs) must be durable and queryable across the lifetime of the retry window (up to several hours after first delivery attempt) plus some buffer for late retries. At high event volume, storing every processed event ID forever is expensive. The practical approach is to use a TTL-based store (Redis with key expiry, or a database table with a cleanup job) with a TTL of twice the maximum retry window. An event that has exhausted all retries will not be re-delivered, so its ID does not need to be retained beyond the retry window. The idempotency check must also handle concurrent delivery attempts: if two retry attempts arrive simultaneously (possible when the retry scheduler has clock skew), a naive check-then-insert sequence has a race condition. Use a database unique constraint on the event ID and catch the constraint violation as a duplicate signal, or use a distributed lock with a short TTL.

**Throughput scaling for high-volume webhook delivery.** A single DeliveryWorker polling every 5 seconds cannot deliver millions of events per day. At scale, the delivery infrastructure is a pool of workers competing on the outbox table using a leader election or database-level row locking (`SELECT ... FOR UPDATE SKIP LOCKED` in PostgreSQL). Each worker claims a batch of undelivered rows, processes them in parallel with bounded concurrency, and releases failed rows back to the queue with updated retry timestamps. The key metric is end-to-end delivery latency: time from event emission to first successful delivery attempt. A production SLO of p99 delivery latency under 30 seconds requires the worker pool to be sized such that the outbox queue depth stays bounded under peak load. This is a capacity planning exercise, not a code exercise.

**Bar-raiser interview signal.** A candidate designing a webhook system who proposes synchronous delivery (call the subscriber endpoint directly from the request handler) is demonstrating unfamiliarity with production failure modes. A candidate who proposes an outbox table, a separate delivery worker, and retry with backoff but does not mention idempotency on the receiver side has designed a reliable sender but not a reliable end-to-end system. A complete senior answer covers both sides: the sender's delivery guarantees and the receiver's correctness requirements, including idempotency, signature verification, timestamp validation, and the 200-immediately-process-async pattern for slow handlers.

---
