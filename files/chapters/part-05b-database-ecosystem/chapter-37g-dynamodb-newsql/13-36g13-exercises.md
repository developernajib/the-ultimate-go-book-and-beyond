## 37G.13 Exercises

**Exercise 1: E-Commerce Single-Table Design**

Design and implement a complete e-commerce system using DynamoDB single-table design:
- Entities: Users, Products, Orders, Reviews, Sessions
- Access patterns: (8 listed above in section 37G.2) + sessions with TTL
- Implement all access patterns with Query (no Scan except admin)
- Handle concurrent orders with transactions
- Implement DynamoDB Streams to sync to Elasticsearch for search

Requirements: Model must support 10K writes/second, all queries < 10ms p99.

**Exercise 2: Multi-Region Inventory Service**

Build a globally distributed inventory management service:
- Use CockroachDB with geo-partitioning (US, EU, APAC)
- Implement reservation system: reserve stock → confirm/release
- Handle distributed transactions across regions
- Implement retry logic for serialization failures
- Benchmark: compare local region reads vs cross-region reads

**Exercise 3: Database Migration Tool**

Build a Go tool to migrate data between database types:
- Source: PostgreSQL → Target: DynamoDB (or vice versa)
- Auto-generate DynamoDB single-table schema from relational schema
- Handle pagination for large tables
- Verify data integrity with row-count and checksum validation
- Support dry-run mode with diff output

### Junior to FAANG: Scoped Exercises and Worked Starters

Do not attempt the three exercises above on your first pass. They are staff-scope. Start with the junior ladder below, then graduate.

Junior Exercise A. Write a Go program that puts 10000 items into a DynamoDB table with pk = "USER#<uuid>" and sk = "PROFILE", then measures throttles under four different capacity settings (on-demand, provisioned 100 WCU, provisioned 500 WCU, provisioned 5000 WCU). Deliverable: a short memo naming which setting produced zero throttles, which produced backoff, and the cost delta per month if you ran this workload continuously. First-job reflex this trains: you stop guessing capacity and start measuring.

Junior Exercise B. Take a Postgres table with 5 columns and 1 million rows (use pgbench or any sample dataset) and map it to a DynamoDB single-table schema supporting three access patterns that you list in writing before you code. Use the AWS SDK v2 BatchWriteItem with proper unprocessed-item retry. Deliverable: the three access patterns, the schema, the load script, and the measured p50 and p99 read latency per pattern.

Junior Exercise C. Given an existing DynamoDB table with a GSI, write a Go program that demonstrates GSI eventual-consistency lag. Put an item into the base table, immediately query the GSI in a loop, and record the time until the GSI returns the new item. Run 1000 trials. Deliverable: a histogram of lag times. This exercise permanently fixes the "never read your own write from a GSI" rule in your head.

Worked starter for Exercise 1 above. Access pattern catalog first.
1. Get user by user_id. pk = "USER#<id>", sk = "PROFILE".
2. List orders for user newest first. pk = "USER#<id>", sk begins_with "ORDER#".
3. Get order by order_id. pk = "ORDER#<id>", sk = "METADATA".
4. List items in an order. pk = "ORDER#<id>", sk begins_with "ITEM#".
5. Get product by product_id. pk = "PRODUCT#<id>", sk = "METADATA".
6. List reviews for a product newest first. GSI1 pk = "PRODUCT#<id>", GSI1 sk = timestamp.
7. Get user session (with TTL). pk = "SESSION#<id>", sk = "METADATA", TTL attribute.
8. Admin: all pending orders. Sparse GSI: GSI2 pk = "STATUS#PENDING", GSI2 sk = timestamp. Only pending items carry GSI2 attributes, so the index is sparse and cheap.

Transaction boundary. Order creation uses TransactWriteItems to atomically decrement product stock and insert the ORDER and ITEM items. Condition expression on stock: attribute_exists(stock) AND stock >= :qty.

### Senior at FAANG: Staff Extensions and Principal-Grade Capstones

The staff-grade version of each exercise replaces "make it work" with "make it reviewable, operable, and defensible in an ADR."

Staff Extension of Exercise 1 (single-table design tool). Build a DynamoDB schema design linter in Go. Input: a YAML access-pattern catalog. Output: a proposed table schema, a list of GSIs with projected attributes, a capacity estimate, and a lint report flagging hot-partition risk (any PK whose cardinality is under 1000 over 30 days of expected traffic), Scan-only patterns, and GSI write amplification above 3x. Stretch: generate a Terraform module and a Go data-access layer from the catalog. This is the kind of internal tool that earns a staff promotion packet.

Staff Extension of Exercise 2 (multi-region conflict resolution strategy). Extend the CockroachDB inventory service with a second implementation on DynamoDB global tables. Write a conflict-resolution ADR comparing the two. Run a controlled chaos experiment: partition the us-east-1 and eu-west-1 regions for 30 seconds, write to both sides, heal the partition, and measure what each system does. DynamoDB global tables will resolve via last-write-wins and you will lose writes. CockroachDB with survival goal = region failure will block writes to the unreachable range, preserving correctness at the cost of availability. Deliverable: a written ADR with "we choose X because correctness versus availability trade Y, and the compensating control is Z."

Staff Extension of Exercise 3 (CDC-to-search pipeline). Replace the ad-hoc dry-run tool with a production-grade CDC pipeline. DynamoDB Streams into a Go consumer, into Kinesis Data Firehose, into OpenSearch, with a DLQ, an age-of-oldest-record alarm, and a replay tool that can rebuild the search index from a point-in-time DynamoDB export in S3. Deliverable: architecture diagram, SLO document (freshness under 60 seconds p99, correctness 100 percent after replay), runbook for a total OpenSearch rebuild.

Principal capstone A. Build a capacity and cost recommender. Ingest 30 days of CloudWatch metrics across a fleet of DynamoDB tables. For each table, recommend on-demand versus provisioned, recommend a provisioned floor and ceiling, recommend GSI projection changes, and estimate the monthly savings. Deliverable: a report that a CFO would sign and an engineering director would trust.

Principal capstone B. Write the "database choice" framework document for your organization. Inputs: workload characteristics (access patterns, scale, consistency, geography, team maturity, cloud strategy). Outputs: a decision tree landing on DynamoDB, Aurora, Spanner, CockroachDB, or "reject the workload, it needs redesign." Validate the framework by running three existing services through it and comparing the framework's recommendation to the current state. Deliverable: a document that becomes the paved road for the next five years.

Bar-raiser grading rubric for any of the above. Access-pattern catalog before schema. Capacity math with a dollar figure. One failure mode named and mitigated. One reversal plan documented. If any of these four is missing, the exercise scored staff-minus, not staff-plus.

---
