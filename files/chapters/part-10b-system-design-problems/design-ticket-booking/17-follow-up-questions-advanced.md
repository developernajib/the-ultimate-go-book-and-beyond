## Follow-up Questions, Advanced

These questions test whether you can reason about operational complexity, business rules, and edge cases beyond the core booking flow. Strong answers demonstrate awareness of the real-world constraints that production ticketing systems face.

**Q: How do you implement dynamic pricing for unsold tickets?**
A background job evaluates sell-through rate every 15 minutes against time-based targets. If 80% of tickets sold within the first hour, increase remaining ticket prices by 20% to capture surplus demand. If only 40% sold after 24 hours, decrease by 10% to stimulate sales. The price never drops below face value (this is typically a contractual requirement from artists and venues). The pricing algorithm tracks demand velocity, a sudden spike in page views for an event signals upcoming demand and prevents premature discounts.

**Q: How handle a 100K-ticket concert cancellation?**
Immediately pause all sales and disable the seat map. Refunds go through a queued worker rather than a loop, throttled below the processor's write limit (Stripe's default is on the order of 100 write operations per second per account) so that refunding a canceled show does not starve live onsales sharing the same account.

Be careful with the arithmetic here, because it is a place interviewers push. At 100 per second, 100K refunds clear in about 17 minutes, so the API limit is not what makes this slow. Money reaching the cardholder takes 5 to 10 business days regardless of how fast the calls go out, so the honest answer is that the refund *requests* finish in minutes and the communication plan has to set expectations about the settlement window. Ordering is FIFO, matching purchase order: refunding recent buyers first has no defensible rationale and reads as arbitrary if you are asked to justify it.

Each refund must be idempotent on the charge ID and must never exceed the amount originally captured, and partial refunds of a booking's service fee need an explicit policy decided before the incident, not during it. Send push notifications and emails to all ticket holders with the cancellation notice and refund timeline. If the event is rescheduled rather than canceled, offer each holder a choice: automatic transfer to the new date or a full refund, with a 14-day deadline to decide.

**Q: How prevent ticket scalping bots?**
Defense-in-depth with five layers: (1) Verified Fan program requiring registration days before the sale, which creates a pre-qualified pool and eliminates anonymous bot accounts. (2) Randomized admission for the highest-demand onsales: rather than scoring the queue's sorted set by arrival timestamp as the FIFO design does, assign scores by lottery once registration closes, so that being first through the door is worth nothing and the fastest bot has no edge over a fan on hotel wifi. This is a real trade rather than a free win, since FIFO is intuitive and easy to explain to angry fans, while a lottery is fairer and feels arbitrary to whoever loses it. (3) Purchase limits per account, IP address, and payment method (typically 4-8 tickets). (4) Post-purchase ML detection that flags accounts with bulk purchases, identical billing addresses, or rapid resale listing patterns. (5) Transfer restrictions for the first 48 hours after purchase, preventing immediate resale. These layers work together, no single measure stops all bots, but the combination makes scalping economically unviable.

**Q: How handle ADA accessibility seating?**
Dedicated accessible sections with wheelchair spaces and companion seats. When a user requests accessible seating, the system auto-selects a wheelchair space and atomically holds the adjacent companion seat. Pricing matches the equivalent non-accessible section (ADA compliance requires equal pricing). No proof of disability is required at purchase, this is a legal requirement under the Americans with Disabilities Act. The venue can verify at entry if needed, but the ticketing system must not create purchase barriers.


---
