## Summary

- **Clarify requirements first**: Spend the opening minutes asking about scale, consistency requirements, read/write ratio, and geographic scope - vague requirements lead to wasted design effort.
- **Capacity estimation sets the stage**: Calculating expected QPS, data volume, and storage needs before drawing any boxes justifies your technology choices and demonstrates quantitative thinking.
- **High-level architecture before details**: Sketch the major components and data flow first. Diving into implementation details too early signals poor structure and can cause you to run out of time.
- **Database selection with justification**: Name a specific database (PostgreSQL, Cassandra, DynamoDB) and explain why its data model, consistency guarantees, and scaling properties fit this use case.
- **Handling bottlenecks systematically**: Identify the component most likely to become a bottleneck under load, then propose a concrete solution (sharding, caching, async processing) with trade-offs acknowledged.
- **Deep-dives into components**: Be prepared to zoom into any box on your diagram - the interviewer may ask you to detail the message queue, the caching layer, or the authentication service at code level.
- **API design in system design**: Define the key API endpoints or event schemas early. They act as a contract between components and reveal assumptions about the data model.
- **Discussing trade-offs explicitly**: For every major decision (SQL vs NoSQL, sync vs async, strong vs eventual consistency) state what you are trading away - interviewers reward self-aware design.
- **Failure modes and reliability**: Address what happens when each component fails - use circuit breakers, retries with backoff, and graceful degradation to show operational maturity.
- **The 45-minute structure**: Allocate roughly 5 minutes on requirements, 5 on estimation, 10 on high-level design, 15 on deep-dive, and 10 on bottlenecks and trade-offs to ensure complete coverage.


### Junior → FAANG: Consolidating System Design Interview Knowledge

A chapter summary is most valuable when you use it to identify your weakest areas rather than to confirm your strongest. After reviewing the summary, rank the topics by your confidence level and immediately spend 30 minutes on the lowest-confidence topic. For system design, the topics that consistently differentiate prepared candidates from unprepared ones are: distributed consistency models (strong, eventual, causal), database selection criteria tied to access patterns, and capacity estimation that drives design decisions rather than being a standalone exercise.

### Senior @ FAANG: Summary as a Transition from Preparation to Interview Performance

Senior engineers approaching a system design interview loop use the summary as a mental warm-up ritual: reading through the key patterns to prime the associative connections that should fire naturally during the interview. The goal is fluency, not recall. At L6, you should be able to discuss any topic in this summary for 10 minutes under adversarial questioning without notes. The bar-raiser is specifically probing the depth of the second and third layers: not just what consistent hashing is, but why virtual nodes matter for rebalancing cost, and how a large number of virtual nodes affects memory overhead. Staff-level interview preparation also includes researching the target company's known infrastructure stack and public engineering blog posts, because interviewers tend to probe in areas that mirror the problems their team actually faces.

---

*Next chapter: Behavioral Interviews, the STAR method, leadership principles, and how to tell compelling stories about your experience.*
