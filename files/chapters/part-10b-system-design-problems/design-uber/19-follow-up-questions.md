## Follow-up Questions

Interviewers often ask these follow-up questions to test how deeply you understand the system beyond the core flow. Each answer below is a concise summary, in an actual interview, you would expand on whichever topic the interviewer digs into. Having short, confident answers for all of these shows breadth of knowledge across the entire ride-sharing domain.

**1. Pooled rides?** Match riders heading the same way with a bounded detour for those already on board. Space-time index. Vehicle-routing problem underneath, so heuristics over a short horizon.

**2. Surge gaming?** 5-min rolling window. Anomaly detection on correlated offline/online toggling. Event zone caps. Reward supply, not scarcity.

**3. Driver fairness?** Idle-time component in the match score. Costs rider latency, so it is a tuned trade, not a free win.

**4. Scheduled rides?** Trigger matching shortly before pickup. Priority assignment. Wider radius fallback.

**5. International pricing?** Per-city pricing config. Local currency. Tax rules. Cached per-region.

Watch the money representation here: "cents" is not universal. JPY and KRW have zero decimal places, so the minor unit is the yen itself, while JOD and KWD have three. Hardcoding a 100x conversion overcharges a Tokyo rider by 100x the moment it multiplies. Store an `int64` of minor units plus the currency code, and get the exponent from the currency, never from a constant.

**6. Driver onboarding?** Background check API. Document verification. Multi-step approval. Training content.

**7. Safety incidents?** Panic button: audio recording, live location sharing, integration with local emergency services (which differ by country, so this is a per-market integration and not one API). Route deviation detection.


---
