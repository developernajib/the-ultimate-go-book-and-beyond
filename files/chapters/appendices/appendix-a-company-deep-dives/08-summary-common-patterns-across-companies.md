## Summary: Common Patterns Across Companies

### 1. Concurrency Patterns

All companies heavily use:
- Worker pools for parallel processing
- Fan-out/fan-in for data aggregation
- Context-based cancellation
- Channel-based communication

### 2. Reliability Patterns

Essential patterns:
- Circuit breakers for fault tolerance
- Retries with exponential backoff
- Health checks and graceful shutdown
- Distributed tracing

### 3. Performance Patterns

Common optimizations:
- Connection pooling
- Zero-allocation logging
- sync.Pool for object reuse
- Efficient serialization (protobuf)

### 4. Interview Preparation Checklist

**Technical Skills:**
- [ ] Master data structures and algorithms
- [ ] Understand concurrency primitives deeply
- [ ] Practice system design (draw diagrams)
- [ ] Know when to use which pattern

**Company-Specific:**
- [ ] Read engineering blogs
- [ ] Study open-source projects
- [ ] Understand business domain
- [ ] Practice relevant problems

**Communication:**
- [ ] Explain trade-offs clearly
- [ ] Ask clarifying questions
- [ ] Think out loud
- [ ] Discuss edge cases

---

---

### 5. Further Reading & Engineering Blog Archives

**Company Engineering Blogs:**
- Google: cloud.google.com/blog
- Uber: eng.uber.com
- Netflix: netflixtechblog.com
- Dropbox: dropbox.tech
- Cloudflare: blog.cloudflare.com

**Practice Platforms:**
- LeetCode (algorithms)
- System Design Primer (github)
- interviewing.io (mock interviews)

**Go-Specific Resources:**
- Kubernetes source code
- Go standard library
- Uber's Go style guide
- Google's Go best practices

---

*The patterns shown in this appendix reflect how these companies have applied Go at scale. Study them alongside the engineering blog posts for deeper context.*

---

| [◀ Chapter 102M: Building an OS in Go](../../part-22-ebpf-linux-internals/chapter-102m-building-an-os-in-go/00-introduction.md) | [Appendix A: FAANG Company Deep Dives](00-introduction.md) | [Appendix B: 200+ Interview Questions](../appendix-b-interview-questions/00-introduction.md) ▶ |
| :--- | :---: | ---: |
