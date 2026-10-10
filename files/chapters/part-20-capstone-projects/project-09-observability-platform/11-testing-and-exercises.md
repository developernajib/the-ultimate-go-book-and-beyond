## Testing and Exercises

These exercises guide you through testing the major subsystems of the observability platform. Each exercise focuses on a different concern: data ingestion correctness, query performance, fault tolerance, and tenant isolation. Working through them will deepen your understanding of the trade-offs involved in building reliable, high-throughput data systems.

### Exercise 1: Metric Ingestion

The goal of this exercise is to verify that the platform correctly ingests metrics regardless of which protocol the application uses to send them. You will write test clients for OTLP, Prometheus scraping, and StatsD, then query the storage layer to confirm the data arrived intact. Pay special attention to label preservation and timestamp accuracy, since even small bugs here can cause dashboards to show incorrect data.

Write a test client that sends metrics via different protocols:

```go
// Test OTLP ingestion
func TestOTLPIngestion(t *testing.T) {
    // Create test metrics
    // Send via OTLP
    // Query and verify
}

// Test Prometheus scraping
func TestPrometheusScraping(t *testing.T) {
    // Start test HTTP server with /metrics endpoint
    // Configure scraper
    // Verify metrics are scraped
}

// Test StatsD ingestion
func TestStatsDIngestion(t *testing.T) {
    // Send StatsD metrics via UDP
    // Verify parsing and storage
}
```

### Exercise 2: Query Performance

Query latency is critical because slow dashboards frustrate users and slow alert evaluations can delay incident detection. In this exercise, you will benchmark the query engine by inserting increasing volumes of test data and measuring how query time scales. This helps you identify bottlenecks such as missing indexes, inefficient label matching, or excessive memory allocation during result assembly.

Benchmark query performance with different data volumes:

```go
func BenchmarkMetricQuery(b *testing.B) {
    // Insert test data
    // Run queries
    // Measure performance
}

func BenchmarkLogQuery(b *testing.B) {
    // Test full-text search performance
    // Test label filtering
}
```

### Exercise 3: High Availability

A production observability platform must remain available even when individual nodes fail, because losing monitoring during an outage is the worst possible time. This exercise walks you through setting up replicated storage, configuring write-ahead replication, and testing what happens when a node goes down. You will measure how quickly the system recovers and whether any data is lost during the failover window.

Implement replication and failover:

1. Set up multiple ClickHouse replicas
2. Configure Prometheus for remote write
3. Test failover scenarios
4. Measure recovery time

### Exercise 4: Multi-Tenancy

When multiple teams or customers share a single observability platform, each tenant must only see their own data. This exercise has you implement tenant ID extraction from authentication tokens, add automatic tenant filters to every query, and verify that no cross-tenant data leakage occurs. You will also benchmark the performance overhead of tenant filtering to ensure it does not significantly increase query latency.

Add tenant isolation:

1. Implement tenant ID extraction
2. Add query filters
3. Test data isolation
4. Benchmark performance impact
