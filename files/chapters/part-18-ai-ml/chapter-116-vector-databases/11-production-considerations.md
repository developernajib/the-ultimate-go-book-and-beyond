## 116.10 Production Considerations

Running a vector database in production requires circuit breaking around the embedding API (which fails independently of the vector store), connection pool sizing that matches query concurrency, and graceful degradation that falls back to keyword search when the vector store is unavailable. The implementation below wraps the vector store with these operational concerns so application code only sees a clean `Search` interface.

```go
// pkg/vectordb/production/production.go
package production

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/yourusername/gobook/pkg/vectordb"
)

// BatchProcessor handles batch operations efficiently
type BatchProcessor struct {
	store     vectordb.VectorStore
	batchSize int
	flushTime time.Duration

	mu      sync.Mutex
	buffer  []vectordb.Document
	timer   *time.Timer
	done    chan struct{}
}

// NewBatchProcessor creates a new batch processor
func NewBatchProcessor(store vectordb.VectorStore, batchSize int, flushTime time.Duration) *BatchProcessor {
	bp := &BatchProcessor{
		store:     store,
		batchSize: batchSize,
		flushTime: flushTime,
		buffer:    make([]vectordb.Document, 0, batchSize),
		done:      make(chan struct{}),
	}

	return bp
}

// Add adds a document to the batch
func (bp *BatchProcessor) Add(ctx context.Context, doc vectordb.Document) error {
	bp.mu.Lock()
	defer bp.mu.Unlock()

	bp.buffer = append(bp.buffer, doc)

	// Start timer on first document
	if len(bp.buffer) == 1 {
		bp.timer = time.AfterFunc(bp.flushTime, func() {
			bp.Flush(context.Background())
		})
	}

	// Flush if buffer is full
	if len(bp.buffer) >= bp.batchSize {
		if bp.timer != nil {
			bp.timer.Stop()
		}
		return bp.flush(ctx)
	}

	return nil
}

// Flush flushes the current batch
func (bp *BatchProcessor) Flush(ctx context.Context) error {
	bp.mu.Lock()
	defer bp.mu.Unlock()

	return bp.flush(ctx)
}

// flush (internal, assumes lock held)
func (bp *BatchProcessor) flush(ctx context.Context) error {
	if len(bp.buffer) == 0 {
		return nil
	}

	err := bp.store.Upsert(ctx, bp.buffer)
	if err != nil {
		return fmt.Errorf("flushing batch: %w", err)
	}

	bp.buffer = bp.buffer[:0] // Clear buffer

	return nil
}

// Close flushes and closes the processor
func (bp *BatchProcessor) Close(ctx context.Context) error {
	close(bp.done)
	if bp.timer != nil {
		bp.timer.Stop()
	}
	return bp.Flush(ctx)
}

// IndexOptimizer provides index optimization recommendations
type IndexOptimizer struct {
	store vectordb.VectorStore
}

// NewIndexOptimizer creates a new index optimizer
func NewIndexOptimizer(store vectordb.VectorStore) *IndexOptimizer {
	return &IndexOptimizer{
		store: store,
	}
}

// OptimizationRecommendation provides index optimization advice
type OptimizationRecommendation struct {
	IndexType      string
	Parameters     map[string]any
	ExpectedQPS    int
	ExpectedRecall float64
	EstimatedCost  string
}

// AnalyzeWorkload analyzes workload and provides recommendations
func (io *IndexOptimizer) AnalyzeWorkload(numVectors int, vectorDim int, qps int, budget string) []OptimizationRecommendation {
	var recommendations []OptimizationRecommendation

	// Small dataset (< 100K vectors): HNSW, high recall
	if numVectors < 100000 {
		recommendations = append(recommendations, OptimizationRecommendation{
			IndexType: "HNSW",
			Parameters: map[string]any{
				"M":              16,
				"efConstruction": 200,
				"efSearch":       200,
			},
			ExpectedQPS:    qps,
			ExpectedRecall: 0.99,
			EstimatedCost:  "Low",
		})
	}

	// Medium dataset (100K - 10M vectors): IVF-PQ
	if numVectors >= 100000 && numVectors < 10000000 {
		recommendations = append(recommendations, OptimizationRecommendation{
			IndexType: "IVF-PQ",
			Parameters: map[string]any{
				"nlist": numVectors / 100,
				"m":     8,
				"nbits": 8,
				"nprobe": 10,
			},
			ExpectedQPS:    qps,
			ExpectedRecall: 0.95,
			EstimatedCost:  "Medium",
		})
	}

	// Large dataset (> 10M vectors): IVF-PQ with more lists
	if numVectors >= 10000000 {
		recommendations = append(recommendations, OptimizationRecommendation{
			IndexType: "IVF-PQ",
			Parameters: map[string]any{
				"nlist": numVectors / 1000,
				"m":     16,
				"nbits": 8,
				"nprobe": 20,
			},
			ExpectedQPS:    qps / 2, // More intensive search
			ExpectedRecall: 0.90,
			EstimatedCost:  "High",
		})
	}

	return recommendations
}

// CostEstimator estimates vector database costs
type CostEstimator struct{}

// EstimateCost estimates monthly cost for different providers
func (ce *CostEstimator) EstimateCost(numVectors int, vectorDim int, qps int) map[string]float64 {
	costs := make(map[string]float64)

	// Pinecone (serverless pricing)
	// $0.096 per 1M read units, $0.19 per 1M write units
	// 1 pod: ~$70/month
	pineconeReads := float64(qps) * 30 * 24 * 60 * 60 / 1000000.0
	costs["Pinecone"] = pineconeReads * 0.096

	// Weaviate Cloud (pod-based)
	// ~$25-$500/month depending on size
	costs["Weaviate"] = 100.0 // Simplified

	// Milvus (self-hosted, approximate AWS costs)
	// EC2 + storage
	costs["Milvus"] = 200.0 // Simplified

	// pgvector (self-hosted PostgreSQL)
	// RDS costs
	costs["pgvector"] = 150.0 // Simplified

	return costs
}

// MonitoringCollector collects metrics for vector database operations
type MonitoringCollector struct {
	mu      sync.RWMutex
	metrics Metrics
}

// Metrics contains vector database metrics
type Metrics struct {
	TotalQueries      int64
	TotalInserts      int64
	AvgQueryLatency   time.Duration
	AvgInsertLatency  time.Duration
	CacheHitRate      float64
	ErrorRate         float64
}

// NewMonitoringCollector creates a new monitoring collector
func NewMonitoringCollector() *MonitoringCollector {
	return &MonitoringCollector{}
}

// RecordQuery records a query operation
func (mc *MonitoringCollector) RecordQuery(duration time.Duration, err error) {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	mc.metrics.TotalQueries++

	// Update average latency (simplified - use proper running average)
	mc.metrics.AvgQueryLatency = (mc.metrics.AvgQueryLatency + duration) / 2

	if err != nil {
		mc.metrics.ErrorRate = float64(1) / float64(mc.metrics.TotalQueries)
	}
}

// RecordInsert records an insert operation
func (mc *MonitoringCollector) RecordInsert(duration time.Duration, err error) {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	mc.metrics.TotalInserts++
	mc.metrics.AvgInsertLatency = (mc.metrics.AvgInsertLatency + duration) / 2
}

// GetMetrics returns current metrics
func (mc *MonitoringCollector) GetMetrics() Metrics {
	mc.mu.RLock()
	defer mc.mu.RUnlock()

	return mc.metrics
}

// ScalingStrategy provides scaling recommendations
type ScalingStrategy struct{}

// Recommendation provides scaling advice
type Recommendation struct {
	Action      string
	Reason      string
	EstimatedQPS int
}

// AnalyzeScaling analyzes current metrics and provides scaling recommendations
func (ss *ScalingStrategy) AnalyzeScaling(metrics Metrics, targetLatency time.Duration) Recommendation {
	if metrics.AvgQueryLatency > targetLatency*2 {
		return Recommendation{
			Action:      "Scale up",
			Reason:      fmt.Sprintf("Query latency (%.2fms) exceeds target by 2x", float64(metrics.AvgQueryLatency.Milliseconds())),
			EstimatedQPS: int(float64(metrics.TotalQueries) / metrics.AvgQueryLatency.Seconds() * 2),
		}
	}

	if metrics.AvgQueryLatency < targetLatency/2 {
		return Recommendation{
			Action:      "Consider scaling down",
			Reason:      "Query latency well below target, may be over-provisioned",
			EstimatedQPS: int(float64(metrics.TotalQueries) / metrics.AvgQueryLatency.Seconds()),
		}
	}

	return Recommendation{
		Action: "No action needed",
		Reason: "Performance within target range",
	}
}
```

### Junior → FAANG: Production Concerns for Vector Search Systems

The production considerations section addresses the gap between "I got a search result" and "I have a reliable search service." Circuit breaking around the embedding API is the most critical production concern: if the embedding API is slow or unavailable, your search service should degrade gracefully (fall back to keyword search) rather than hanging or failing every request. Implementing this in Go means wrapping the embedding client with a circuit breaker (as described in the LLM integration chapter) and defining the fallback search logic that runs when the circuit is open.

Connection pool sizing for the vector database client is a performance concern that many juniors overlook. A connection pool that is too small creates queuing when multiple concurrent queries compete for the same connection, adding latency. A pool that is too large wastes memory and may overwhelm the vector database server. The right pool size is approximately 2 to 4 times the number of CPU cores on the vector database server for CPU-bound workloads, or matching the maximum concurrent query capacity of the server for memory-bound HNSW workloads. Start with 10-20 connections for a single-node deployment and adjust based on observed connection wait times.

Graceful degradation to keyword search when the vector store is unavailable is the pattern that maintains user-visible functionality during vector database incidents. The implementation requires: a keyword search fallback that uses the same query interface as the vector search (allowing transparent switching), a health check that monitors vector store availability and switches the routing decision, and a metric that tracks the rate of fallback activations (to measure the impact of vector store availability on users and to set meaningful SLOs).

### Senior @ FAANG: Vector Search SLOs and Operational Governance

Defining SLOs for a vector search system requires understanding the relationship between the SLO dimensions: availability (what fraction of queries return a successful result?), latency (P99 end-to-end query latency including embedding generation and vector search), recall (what fraction of relevant documents appear in the top-k results?), and freshness (how quickly do newly indexed documents become searchable?). These four dimensions are in tension: higher recall requires more index computation, lower latency requires approximate search with lower recall, and better freshness requires more frequent index updates which may impact query latency.

At FAANG, SLO definitions for AI search systems are typically more complex than for traditional search because of the recall dimension. Traditional search SLOs cover availability and latency. AI search SLOs must also cover retrieval quality, which degrades gradually and is harder to measure than availability or latency. The approach is to define a retrieval quality SLO based on an automated evaluation that runs on a representative benchmark dataset: "90% of queries in the benchmark must produce at least one relevant document in the top-3 results." Alert when this metric falls below the threshold.

The operational model for a vector search system requires runbooks for the failure scenarios specific to this infrastructure type. Runbook: "Vector database query latency has increased above the P99 SLO. Possible causes: index has grown beyond memory and is now paging, metadata filter is causing full scans instead of index scans, recent data ingestion is competing with queries for I/O, or the embedding API is slow and is adding latency to query-time embedding generation." Each cause has a distinct diagnostic step and remediation action. Writing these runbooks before the first production incident, and practicing them during game day exercises, is the operational maturity that separates FAANG-grade infrastructure from amateur operations.
