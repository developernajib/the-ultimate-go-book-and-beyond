## Follow-up Questions, Advanced

These advanced follow-ups go beyond core architecture into product-level and operational concerns. Interviewers ask these to test whether you can think about the system end-to-end, not just "how does it work?" but "how does it make money?", "how does it comply with regulations?", and "how does it scale internationally?". Being able to discuss even two or three of these topics fluently signals senior-level thinking.

**Q: How would you implement Superhost status?**

Criteria assessed quarterly: (1) 10+ stays per year, (2) 90%+ response rate, (3) cancellation rate under 1%, (4) 4.8+ rating. A quarterly batch job evaluates all hosts. The badge feeds into search ranking as a boost signal.

**Q: How do you handle multi-currency international bookings?**

Listing price in host currency. Convert to guest currency using cached exchange rates (refreshed hourly). Lock rate during checkout (10 min). Payment in guest currency, payout in host currency. Platform absorbs exchange rate risk.

**Q: How does search ranking work?**

Multi-factor: relevance, quality (Bayesian rating), conversion rate, recency, price competitiveness, response rate, Superhost boost. Weights trained via click-through rate optimization ML model.

**Q: How do you handle regulatory compliance (short-term rental laws)?**

Geofencing per jurisdiction. Some cities require: max 90 nights/year, registration number, occupancy tax. Implementation: listing-level regulatory config that enforces calendar blocking, mandatory fields, and automated tax calculation.

**Q: How would you design the host payout system?**

Payment is captured at booking confirmation. The host payout is held until 24 hours after check-in (the dispute window), then released on the host's payout schedule. Multi-currency conversion happens at payout time. Tax reporting: 1099-K forms for US hosts above the IRS reporting threshold.


---
