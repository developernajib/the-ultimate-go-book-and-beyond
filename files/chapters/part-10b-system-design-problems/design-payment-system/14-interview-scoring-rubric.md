## Interview Scoring Rubric

This rubric shows what interviewers expect at each seniority level. Use it to calibrate the depth of your answer: an L4 candidate explaining double-entry ledger details is spending time on the wrong things, while an L6 candidate who stops at idempotency is under-performing. Focus on nailing the expectations for your target level first, then layer on advanced topics if time permits.

### L4 (Junior/Mid)
- Basic authorize-then-capture flow with clear state transitions (pending, authorized, captured, failed)
- Idempotency keys to prevent double-charging on retry
- PCI DSS awareness: never store raw card numbers, use processor tokenization
- **Missing at this level (expected):** double-entry ledger, ML-based fraud detection, daily reconciliation

### L5 (Senior)
- Payment state machine with explicit transitions and guards (cannot refund a pending payment)
- Double-entry ledger: every payment creates two journal entries (debit + credit) that sum to zero
- Redis-backed idempotency with distributed locking to prevent concurrent duplicate processing
- Fraud detection with velocity features (transaction count per hour, amount z-score) and ML scoring under 100ms
- Multi-currency support with exchange rate management and FX markup
- Webhook retry with exponential backoff and dead-letter queue for failed deliveries
- **Missing at this level (expected):** settlement pipeline, processor failover, dispute/chargeback workflow

### L6 (Staff)
- Saga pattern for distributed transactions: compensating actions (void/refund) when downstream steps fail
- Reconciliation pipeline: nightly batch compares internal ledger against processor settlement statements
- Processor failover, and knowing its limit: an idempotency key is scoped to one processor's namespace and buys nothing at a second one, so failover is only safe for errors that prove no charge was created. On an ambiguous failure such as a timeout, the payment stays pending for reconciliation rather than being re-sent elsewhere.
- PCI scope reduction to SAQ A via client-side tokenization (Stripe.js/Adyen Drop-in)
- Cross-currency FX journal entries: separate ledger records for the conversion event, including rate, markup, and timestamp
- Full dispute/chargeback workflow: evidence submission, representment, pre-arbitration, arbitration
- CAP theorem trade-offs: choosing CP over AP for payment state (it is better to reject a payment than to process it twice)

---
