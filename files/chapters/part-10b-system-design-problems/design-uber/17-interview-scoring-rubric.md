## Interview Scoring Rubric

This rubric shows what interviewers expect at different engineering levels. An L4 (junior) candidate should cover the basic flow, while an L5 (mid-level) candidate needs to discuss specific technology choices and their trade-offs. An L6 (senior) candidate is expected to go deeper into advanced topics like geographic sharding, fraud detection, and pooled rides.

**L4:** Rider -> API -> matching -> driver flow. GPS location. Distance-based pricing.

**L5:** Redis GEO. Trip state machine. Multi-factor scoring. Surge pricing. Idempotent payments.

**L6:** H3 hexagonal grid. Dispatch queue with cascading offers. Fraud detection. Geographic sharding. Payment retry escalation. Pooled rides.

One question separates levels faster than any topic in the list: "two riders request at the same instant and your matcher picks the same driver for both. What stops the double booking?" Candidates who answer with a Redis check or a status flag have not understood the problem, because both readers see "available". The answer an interviewer is listening for is that a read cannot exclude a concurrent writer, so exclusivity has to come from an atomic operation or a uniqueness constraint at the point of the write. The same reasoning covers the accept-versus-timeout race in the dispatch queue and the retry-versus-charge race in payments, which is why it is worth being able to state the general form rather than three memorized fixes.

---
