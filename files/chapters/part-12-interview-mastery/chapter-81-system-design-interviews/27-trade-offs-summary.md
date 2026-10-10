## Trade-offs Summary

| Decision | Trade-off |
|----------|-----------|
| 4MB chunk size | Balance between metadata overhead and transfer efficiency |
| SHA-256 dedup | Computation cost vs storage savings |
| Vector clocks | Complexity vs accurate conflict detection |
| S3 for blocks | Cost vs building own distributed storage |

### Junior → FAANG: Summarizing Design Trade-offs

A trade-offs summary section trains you to articulate what you gave up with each decision. Every design choice has a cost: consistency costs availability, low latency costs durability, simplicity costs flexibility. In interviews, proactively naming the trade-off before the interviewer asks demonstrates engineering maturity. The format to practice: 'I chose X over Y because Z, and the trade-off is A. If A becomes unacceptable, I would revisit this decision and consider B instead.'

### Senior @ FAANG: Trade-offs as ADR Content and Bar-Raiser Signal

At the senior level, trade-off articulation is the primary signal bar-raisers use to differentiate L5 from L6 candidates. An L5 candidate chooses a reasonable design. An L6 candidate chooses a reasonable design, articulates three alternative approaches they considered, explains the criteria used to select the chosen approach, and names the conditions under which they would revisit the decision. This is exactly the structure of an ADR. Staff-level trade-off discussions also include organizational trade-offs: some technical approaches are ruled out not because they are wrong but because they require organizational capabilities that do not yet exist (a sophisticated on-call rotation for a complex distributed system, specialized expertise for operating a particular database, or a data platform team to manage a data warehouse). Naming these organizational constraints in a design review is a signal of staff-level awareness.

---

### Exercise 3: Design Real-Time Chat - Complete Solution

This solution walks through a complete real-time chat system design following the four-step framework: requirements gathering, capacity estimation, high-level architecture, and deep dives into WebSocket management, message ordering, and presence tracking. The reference solution follows.
