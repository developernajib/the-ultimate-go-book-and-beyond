## Scaling Considerations

Each component in the Twitter timeline system has a different scaling bottleneck and requires a targeted strategy. API servers scale horizontally because they are stateless. Data stores scale by sharding or partitioning. The table below summarizes the approach for each component.

| Component | Scaling Strategy |
|-----------|-----------------|
| API Servers | Horizontal, stateless |
| Tweet Store | Cassandra (horizontal sharding) |
| Timeline Cache | Redis Cluster (hash slots) |
| Fan-out Queue | Kafka partitions |
| User Graph | Graph DB + cache |


### Junior → FAANG: Scaling Fundamentals for Interviews

Scaling is discussed on two axes: vertical (bigger machines) and horizontal (more machines). In interviews, always start with horizontal scaling as the primary approach because it is the pattern FAANG uses at scale. Know the stateless versus stateful distinction: stateless services scale horizontally with no coordination overhead. Stateful services require distributed state management, leader election, or sticky routing. The four areas where scaling gets interesting in interviews are the database (sharding strategies, read replicas), the cache (consistent hashing, eviction policies), the message queue (partitioning, consumer groups), and the service discovery layer (load balancer health checks, auto-scaling). Demonstrate that you understand the bottleneck moves as you scale: at low scale the database is the bottleneck, at higher scale it becomes the network, at even higher scale it becomes the coordination overhead.

### Senior @ FAANG: Scaling as a Platform Capability, Not a Feature

Senior engineers distinguish between scaling a single service and building a platform that scales. The former is tactical. The latter is strategic. At the staff level, scaling decisions are governance decisions: you are setting the precedent for how your org handles growth. Key considerations include the cost of scaling (egress costs, licensing costs, operational overhead of distributed systems), the reliability implications of scaling (more nodes means more failure modes, partial availability states are harder to reason about), and the observability requirements that grow with scale (you cannot debug a distributed system without structured traces and per-request correlation IDs). Bar-raisers at L6/L7 expect you to distinguish between scaling for throughput (handling more requests per second), scaling for data volume (handling more stored data), and scaling for availability (handling node failures without downtime). These often require different architectural approaches. A common senior mistake in interviews is conflating throughput and availability: adding more replicas improves availability but does not always improve throughput if the bottleneck is coordination.
