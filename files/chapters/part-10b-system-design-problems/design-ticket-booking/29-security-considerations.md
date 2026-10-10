## Security Considerations

Security in a ticket booking system spans five areas: payment fraud, queue manipulation, ticket forgery, scalping, and data privacy. Each area needs countermeasures that work together as defense-in-depth. HMAC-signed queue tokens prevent queue-jumping, rotating QR codes shrink the useful life of a stolen screenshot, and purchase limits combined with detection models raise the cost of bulk scalping. The checklist below is a starting point for a security review, not the end of one.

```
Ticket Security Checklist:

1. Payment Security:
   - PCI DSS compliance (Stripe handles card data)
   - Idempotency keys prevent double charges, derived from the hold ID
     (which exists before the charge; the booking ID does not yet)
   - Amounts computed server-side from seat prices in integer cents, never
     taken from the client, and never held in a float
   - Refunds only via admin API or the automated seat-conflict path, always
     for the exact amount captured and never for a recomputed one

2. Queue Fairness:
   - HMAC-signed queue tokens carry their payload and are verified with
     a constant-time compare (a bare signature cannot be verified at all,
     since the verifier cannot recover what was signed)
   - Token bound to device fingerprint (not transferable)
   - Rate limiting: 1 queue join per device per 60 seconds
   - Queue scores coarsened to a 30s bucket with randomization inside it,
     so a bot arriving 200ms earlier gains nothing. This is a deliberate
     softening of strict FIFO; the highest-demand onsales go further and
     assign scores by lottery once registration closes.

3. Ticket Authenticity:
   - QR codes contain an HMAC signature over (ticket, event, owner),
     compared in constant time
   - SafeTix rotating codes change every 30 seconds
   - A screenshot stops validating 30-60s after capture (the scanner
     accepts the previous window too, for clock skew). Inside its window
     a copy is indistinguishable from the original, so rotation limits
     exposure rather than preventing duplication
   - The one-time scan is what actually enforces one admission per seat:
     UPDATE ... WHERE is_used = false, so two gates racing the same code
     resolve to exactly one entry

4. Anti-Scalping:
   - Resale price cap (120% of face value)
   - Purchase limit per account/IP/payment method
   - Transfer restrictions for first 48 hours
   - ML model detects bulk purchase patterns

5. Data Protection:
   - Payment data never stored (Stripe tokens only)
   - Personal data encrypted at rest
   - Audit log for all ticket operations
   - GDPR compliance: data deletion on request, with the caveat that
     completed bookings are financial records: anonymize the person,
     retain the transaction
```

---
