## 1. Fan-Out / Fan-In Pattern

Fan-out/fan-in splits work into parallel branches (fan-out) and collects their results into a single aggregate (fan-in). In Temporal, each branch is an activity execution that returns a `workflow.Future`. The workflow launches all activities without blocking, then calls `Get` on each future to collect results. Because Temporal activities run on workers (potentially different machines), this achieves true distributed parallelism rather than just concurrency within a single process.

This implementation demonstrates three variants: a fixed fan-out where a known set of enrichment sources run in parallel, a dynamic fan-out where the number of parallel tasks comes from runtime input, and a selector-based fan-out that returns the first successful result (useful for redundant backends).

Individual activity failures are handled gracefully. In the enrichment workflow, a failed source produces an error entry rather than aborting the entire operation. In the dynamic workflow, partial failures are collected and reported alongside successful results.

```go
package fanout

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ProductInfo holds information about a product
type ProductInfo struct {
	ProductID   string
	Name        string
	PriceCents  int64
	Stock       int
	Description string
}

// EnrichmentResult holds enrichment data from one source
type EnrichmentResult struct {
	Source string
	Data   map[string]any
	Error  string
}

// EnrichedProduct combines product info with enrichment data
type EnrichedProduct struct {
	Product     ProductInfo
	Enrichments []EnrichmentResult
	ProcessedAt time.Time
}

// ProductEnrichmentActivities contains all enrichment activities
type ProductEnrichmentActivities struct {
	pricingServiceURL    string
	inventoryServiceURL  string
	reviewsServiceURL    string
	analyticsServiceURL  string
}

// FetchPricingData retrieves pricing information
func (a *ProductEnrichmentActivities) FetchPricingData(ctx context.Context, productID string) (EnrichmentResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Fetching pricing data", "productID", productID)

	// Simulate external call
	time.Sleep(50 * time.Millisecond)

	return EnrichmentResult{
		Source: "pricing",
		Data: map[string]any{
			"basePriceCents":       int64(2999),
			"discountedPriceCents": int64(2499),
			"currency":             "USD",
			"priceHistoryCents":    []int64{2999, 2799, 2499},
		},
	}, nil
}

// FetchInventoryData retrieves inventory information
func (a *ProductEnrichmentActivities) FetchInventoryData(ctx context.Context, productID string) (EnrichmentResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Fetching inventory data", "productID", productID)

	time.Sleep(80 * time.Millisecond)

	return EnrichmentResult{
		Source: "inventory",
		Data: map[string]any{
			"stockLevel":      150,
			"warehouse":       "US-WEST-1",
			"replenishDate":   "2026-04-01",
			"lowStockAlert":   false,
		},
	}, nil
}

// FetchReviewsData retrieves review information
func (a *ProductEnrichmentActivities) FetchReviewsData(ctx context.Context, productID string) (EnrichmentResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Fetching reviews data", "productID", productID)

	time.Sleep(120 * time.Millisecond)

	return EnrichmentResult{
		Source: "reviews",
		Data: map[string]any{
			"averageRating": 4.5,
			"reviewCount":   1284,
			"sentiment":     "positive",
			"topReview":     "Excellent product, highly recommended!",
		},
	}, nil
}

// FetchAnalyticsData retrieves analytics information
func (a *ProductEnrichmentActivities) FetchAnalyticsData(ctx context.Context, productID string) (EnrichmentResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Fetching analytics data", "productID", productID)

	time.Sleep(100 * time.Millisecond)

	return EnrichmentResult{
		Source: "analytics",
		Data: map[string]any{
			"viewsLast30Days":    45230,
			"conversionRate":     0.032,
			"cartAbandonRate":    0.68,
			"recommendedWith":    []string{"PROD-456", "PROD-789"},
		},
	}, nil
}

// ProductEnrichmentWorkflow orchestrates parallel enrichment
func ProductEnrichmentWorkflow(ctx workflow.Context, product ProductInfo) (EnrichedProduct, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting product enrichment", "productID", product.ProductID)

	// Activity options with short timeouts for enrichment calls
	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
			InitialInterval: 100 * time.Millisecond,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	// Fan-out: launch all enrichment activities in parallel
	var pricingFuture workflow.Future
	var inventoryFuture workflow.Future
	var reviewsFuture workflow.Future
	var analyticsFuture workflow.Future

	pricingFuture = workflow.ExecuteActivity(ctx,
		(*ProductEnrichmentActivities)(nil).FetchPricingData, product.ProductID)
	inventoryFuture = workflow.ExecuteActivity(ctx,
		(*ProductEnrichmentActivities)(nil).FetchInventoryData, product.ProductID)
	reviewsFuture = workflow.ExecuteActivity(ctx,
		(*ProductEnrichmentActivities)(nil).FetchReviewsData, product.ProductID)
	analyticsFuture = workflow.ExecuteActivity(ctx,
		(*ProductEnrichmentActivities)(nil).FetchAnalyticsData, product.ProductID)

	// Fan-in: collect results (errors are non-fatal for enrichment)
	var enrichments []EnrichmentResult

	var pricingResult EnrichmentResult
	if err := pricingFuture.Get(ctx, &pricingResult); err != nil {
		logger.Warn("Pricing enrichment failed", "error", err)
		enrichments = append(enrichments, EnrichmentResult{
			Source: "pricing",
			Error:  err.Error(),
		})
	} else {
		enrichments = append(enrichments, pricingResult)
	}

	var inventoryResult EnrichmentResult
	if err := inventoryFuture.Get(ctx, &inventoryResult); err != nil {
		logger.Warn("Inventory enrichment failed", "error", err)
		enrichments = append(enrichments, EnrichmentResult{
			Source: "inventory",
			Error:  err.Error(),
		})
	} else {
		enrichments = append(enrichments, inventoryResult)
	}

	var reviewsResult EnrichmentResult
	if err := reviewsFuture.Get(ctx, &reviewsResult); err != nil {
		logger.Warn("Reviews enrichment failed", "error", err)
		enrichments = append(enrichments, EnrichmentResult{
			Source: "reviews",
			Error:  err.Error(),
		})
	} else {
		enrichments = append(enrichments, reviewsResult)
	}

	var analyticsResult EnrichmentResult
	if err := analyticsFuture.Get(ctx, &analyticsResult); err != nil {
		logger.Warn("Analytics enrichment failed", "error", err)
		enrichments = append(enrichments, EnrichmentResult{
			Source: "analytics",
			Error:  err.Error(),
		})
	} else {
		enrichments = append(enrichments, analyticsResult)
	}

	return EnrichedProduct{
		Product:     product,
		Enrichments: enrichments,
		ProcessedAt: workflow.Now(ctx),
	}, nil
}

// DynamicFanOutWorkflow handles dynamic number of parallel tasks
func DynamicFanOutWorkflow(ctx workflow.Context, items []string) ([]string, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting dynamic fan-out", "itemCount", len(items))

	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 2,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	// Launch all activities in parallel
	futures := make([]workflow.Future, len(items))
	for i, item := range items {
		futures[i] = workflow.ExecuteActivity(ctx, ProcessItemActivity, item)
	}

	// Collect results
	results := make([]string, 0, len(items))
	var errs []error

	for i, future := range futures {
		var result string
		if err := future.Get(ctx, &result); err != nil {
			logger.Error("Item processing failed",
				"item", items[i], "error", err)
			errs = append(errs, fmt.Errorf("item %s: %w", items[i], err))
		} else {
			results = append(results, result)
		}
	}

	if len(errs) > 0 {
		return results, fmt.Errorf("partial failure: %d errors", len(errs))
	}

	return results, nil
}

// ProcessItemActivity processes a single item
func ProcessItemActivity(ctx context.Context, item string) (string, error) {
	return fmt.Sprintf("processed:%s", item), nil
}

// SelectBasedFanOut uses selector for first-complete wins
func SelectBasedFanOut(ctx workflow.Context, searchQuery string) (string, error) {
	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	// Fan out to multiple search backends
	backends := []string{"elasticsearch", "opensearch", "solr"}
	futures := make([]workflow.Future, len(backends))

	for i, backend := range backends {
		futures[i] = workflow.ExecuteActivity(ctx, SearchBackendActivity, backend, searchQuery)
	}

	// First-complete wins pattern using selector
	selector := workflow.NewSelector(ctx)
	resultCh := workflow.NewChannel(ctx)

	for _, future := range futures {
		f := future // capture loop variable
		selector.AddFuture(f, func(f workflow.Future) {
			var result string
			if err := f.Get(ctx, &result); err == nil {
				resultCh.SendAsync(result)
			}
		})
	}

	// Wait for first success
	var firstResult string
	selector.Select(ctx)

	if ok := resultCh.ReceiveAsync(&firstResult); ok {
		return firstResult, nil
	}

	// All failed - wait for rest
	for i := 1; i < len(futures); i++ {
		selector.Select(ctx)
		if ok := resultCh.ReceiveAsync(&firstResult); ok {
			return firstResult, nil
		}
	}

	return "", fmt.Errorf("all search backends failed")
}

// SearchBackendActivity searches a specific backend
func SearchBackendActivity(ctx context.Context, backend, query string) (string, error) {
	return fmt.Sprintf("results from %s for: %s", backend, query), nil
}
```

### Junior → FAANG: Understanding Futures and Parallel Execution

The core concept to internalize here is that `workflow.ExecuteActivity` returns immediately with a `Future`. The activity is scheduled and begins executing (on a worker), but the workflow coroutine moves on to the next line. This is not a background goroutine. Temporal manages the scheduling. The workflow only blocks when you call `future.Get(ctx, &result)`.

**Common first-job confusion: calling Get immediately.** A frequent mistake is writing:

```go
var result1 string
workflow.ExecuteActivity(ctx, Activity1).Get(ctx, &result1) // blocks here

var result2 string
workflow.ExecuteActivity(ctx, Activity2).Get(ctx, &result2) // sequential, not parallel
```

This is sequential, not parallel. The fan-out pattern requires launching all futures before calling Get on any of them. If you see an interviewer present this sequential pattern and ask what is wrong with it, the answer is: latency is additive. If each activity takes 1 second, the sequential version takes N seconds instead of 1 second.

**Handling partial failures is a design decision, not an afterthought.** In the enrichment workflow, a failed enrichment source produces an error entry in the result rather than aborting the workflow. This is an explicit business decision: enrichment is best-effort. In a payment workflow, a failed step is almost never best-effort. Ask which failure model applies before writing a single line of fan-out code.

**Interview framing for fan-out.** When the prompt is "parallelize N independent calls," walk through: (1) why parallel reduces latency, (2) how to model partial failure, (3) what happens to the Temporal history (one event per activity start and one per completion). The history point matters because unbounded fan-out to thousands of items creates a history too large to replay efficiently.

**The selector variant for first-complete-wins.** The `SelectBasedFanOut` example demonstrates a hedge-request pattern: send the same query to multiple backends and take the fastest response. This is appropriate for read-only operations (search, enrichment, cache lookup) where any response is equally valid. Never use it for writes, since multiple backends would commit simultaneously.

### Senior @ FAANG: Fan-Out at Scale and History Bound Management

At production scale, fan-out patterns introduce constraints that are invisible in small-scale examples. Staff-level thinking requires addressing these constraints before deployment, not after the first incident.

**History size is the primary limit on fan-out width.** Temporal's default history event limit is 50,000 events per workflow execution. Each activity launch contributes two events (ActivityTaskScheduled and ActivityTaskStarted) and each completion contributes one (ActivityTaskCompleted). A fan-out of 10,000 items in a single workflow execution consumes 30,000 history events, leaving limited headroom for retry events and decision events. The remediation is hierarchical fan-out: a parent workflow that spawns child workflows, each handling a bounded slice of the work, so no single execution's history grows unbounded.

**Concurrency control is a cluster protection contract.** The `ConcurrencyControlledFanOut` function is not just a performance optimization. It is a contract between the workflow and the Temporal cluster operator. An unconstrained fan-out to 10,000 child workflows simultaneously can saturate the cluster's task queue poller capacity, delay unrelated workflows, and cause cascading timeouts. The sliding-window selector approach (launch N, wait for one to complete, launch the next) keeps cluster load predictable under any input size. This is the pattern to mandate in your internal pattern guide.

**Selector-based fan-out and the event loop model.** The `workflow.NewSelector` approach in Temporal is the workflow-safe analog of Go's `select` statement. Because workflow code must be deterministic, you cannot use Go's native `select` on channels. The selector records which future completed in the history, so replay always takes the same branch. Understanding this distinction is a bar-raiser signal: a candidate who uses Go channels or goroutines inside a workflow has not internalized the execution model.

**ADR: activity fan-out versus child workflow fan-out.** The decision between the two belongs in your team's pattern ADR:

- Activity fan-out: all activities share the parent workflow's history. Use when total item count is bounded (fewer than a few hundred items), each activity completes in under a few minutes, and there is no need to independently version, cancel, or query individual items.
- Child workflow fan-out: each item gets its own execution with independent history, retry policy, and version state. Use when item count is large, individual items may run for hours, or individual items may need to be canceled or queried independently.

The cost of the wrong choice is discovered at scale: either history overflow (activity fan-out chosen when child workflows were needed) or excessive cluster metadata overhead from millions of short-lived child workflows that should have been activities.

**Partial failure policy as a platform requirement.** Every fan-out at scale must have a documented partial failure policy. Options include: fail-fast (first error aborts, compensations fire), best-effort (collect all results, report errors in aggregate), threshold-based (fail if error rate exceeds N%), and quorum (require M of N successes). This policy belongs in the workflow's design doc, not in a comment in the code. Different callers of the same fan-out pattern may need different policies, which is an argument for parameterizing the failure policy rather than hardcoding it.

---
