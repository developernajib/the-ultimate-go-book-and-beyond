## 81.12 Exercises with Complete Solutions

### Exercise 1: Design Twitter Timeline - Complete Solution

**Requirements Recap**:
- 300M monthly users, 150M daily active
- 500M tweets/day
- Users follow up to 5000 accounts
- Timeline shows 200 most recent tweets from followed accounts

**Complete Solution**: the following sections walk the full reference design, from capacity estimation through failure handling.

### Junior → FAANG: Learning from Complete Solutions

Reading a complete solution after attempting the exercise yourself is the most valuable use of this material. Compare your design against the reference on four dimensions: correctness (does it satisfy the stated requirements), completeness (did you miss any major component), efficiency (is there a simpler way to achieve the same goal), and scalability (how does your design behave at 10x stated load). For juniors, the most common gap is completeness: forgetting the CDN, the load balancer, or the monitoring layer. Build a mental checklist of the infrastructure components that belong in almost every system design: DNS, CDN, load balancer, API gateway, service layer, database, cache, queue, and observability stack.

### Senior @ FAANG: Using Reference Solutions to Calibrate Senior-Level Depth

At the senior level, reference solutions reveal the decisions you need to be able to articulate, not just recognize. For each design decision in the solution, ask: what would make you choose differently? If the solution uses Kafka for the messaging layer, when would you use a simpler queue like SQS or RabbitMQ instead? If it uses PostgreSQL, when would you shard versus use a distributed SQL system like CockroachDB or Spanner? Bar-raisers test the depth of these trade-off discussions. Staff engineers also use reference solutions as inputs to internal standards: if a canonical solution consistently uses a particular pattern, that is a candidate for your org's reference architecture documentation. The governance concern is ensuring that teams are not independently reinventing decisions that have already been made and documented.
