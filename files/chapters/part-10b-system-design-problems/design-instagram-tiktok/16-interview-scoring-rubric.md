## Interview Scoring Rubric

This rubric shows what interviewers expect at different seniority levels. Use it to calibrate how deep you need to go in your answer. An L4 candidate should cover the basics, while an L6 candidate is expected to proactively discuss edge cases, failure modes, and optimizations without being prompted. Knowing where the bar is helps you prioritize which components to discuss first and which to save for follow-up questions.

### L4, Expected
- Upload + feed read flow, basic schema, CDN mention, chronological feed

### L5, Strong Hire
- Fan-out on write, celebrity hybrid push/pull
- Media processing pipeline, pre-signed URLs
- Cassandra for posts, Redis for feed + counters
- HLS adaptive streaming, Stories with TTL
- Notification system

### L6, Exceptional
- All L5 plus:
- Content moderation pipeline (NSFW, CSAM)
- View counting (HyperLogLog + write coalescing)
- Multi-region deployment
- Feed ranking algorithm
- Notification batching
- Media processing checkpoint/resume
- Feed cache degradation strategy

---
