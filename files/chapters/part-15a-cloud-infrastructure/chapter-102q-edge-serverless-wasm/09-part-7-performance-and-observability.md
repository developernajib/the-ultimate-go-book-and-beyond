## 102Q.7 Performance and Observability

Serverless functions introduce a unique performance challenge: the cold start, which is the latency added when the platform must provision a new execution environment before the handler can run. Measuring and minimizing cold start duration is therefore the primary performance concern for latency-sensitive serverless workloads. This section covers how to instrument cold start detection, emit structured metrics to CloudWatch, and use distributed tracing with AWS X-Ray so you can observe the full request lifecycle across multiple Lambda invocations.

### Cold Start Measurement

Cold start duration is most accurately captured by recording a timestamp at `init` time (before `main` executes) and comparing it to the timestamp at the start of the first handler invocation. Subsequent invocations on the same execution environment skip the init phase entirely, so the flag below transitions to `false` after the first call and the metric is only emitted for true cold starts.

```go
package telemetry

import (
	"fmt"
	"os"
	"time"
)

var (
	// Set at init time to measure cold start
	initTime = time.Now()
	isColdStart = true
)

// ColdStartDuration returns how long the cold start took
func ColdStartDuration() time.Duration {
	return time.Since(initTime)
}

// MarkWarm marks the function as warmed up after first invocation
func MarkWarm() {
	isColdStart = false
}

// IsColdStart returns true on the first invocation
func IsColdStart() bool {
	return isColdStart
}

// LambdaMetrics collects Lambda-specific metrics
type LambdaMetrics struct {
	FunctionName    string
	FunctionVersion string
	MemorySize      int
	RequestID       string
}

func FromEnvironment() LambdaMetrics {
	return LambdaMetrics{
		FunctionName:    os.Getenv("AWS_LAMBDA_FUNCTION_NAME"),
		FunctionVersion: os.Getenv("AWS_LAMBDA_FUNCTION_VERSION"),
		MemorySize:      parseIntEnv("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", 128),
	}
}

func parseIntEnv(key string, defaultVal int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	n := 0
	fmt.Sscanf(v, "%d", &n)
	if n == 0 {
		return defaultVal
	}
	return n
}
```

---

### Junior → FAANG: Cold Start Measurement as the Primary Lambda Performance Skill

Cold start detection in the handler, checking whether the initialization variable is being set for the first time, is the foundation for all Lambda performance analysis. Without this signal, cold start latency is invisible in your metrics: it appears as high-percentile latency spikes that are hard to distinguish from slow business logic. Tagging cold start invocations with a metric dimension allows you to separate the two, which is the prerequisite for any cold start optimization work.

The structured metrics via EMF (Embedded Metric Format) pattern is the correct way to emit custom metrics from Lambda: JSON printed to stdout with the `_aws.Metrics` schema is automatically parsed by CloudWatch and converted to metrics without a separate PutMetricData API call. This is important because Lambda billing includes the number of API calls the function makes. Using EMF for metrics costs nothing extra, while PutMetricData calls add both latency and cost at high invocation rates.

First-job habit: set up X-Ray tracing on every Lambda function in your first production service. The subsegment pattern in this section (creating a subsegment for each downstream call) makes it possible to see exactly where a slow invocation spent its time. Without X-Ray, debugging a p99 latency regression requires log analysis across multiple CloudWatch log groups, which is slow and error-prone.

### Senior @ FAANG: Serverless Observability as a Platform Contract

At staff level, the observability configuration in this section is a starting point for a platform observability contract: every Lambda function deployed by any team must emit cold start detection, must have X-Ray tracing enabled, and must emit at minimum the standard metric set (invocation count, cold start count, downstream latency per integration). This is not a recommendation. It is a deployment requirement enforced by the platform team's Lambda wrapper or CDK construct.

The organizational case for this contract: when a production Lambda incident occurs, the time to diagnosis is directly proportional to the observability infrastructure in place. Functions with X-Ray tracing and structured cold start metrics are diagnosable in minutes. Functions with only Lambda's default CloudWatch metrics require ad-hoc log analysis that can take hours. Standardizing observability across all Lambda functions converts an organizational variable (observability quality depends on which team owns the function) into an organizational constant.

The Lambda Powertools for Go library encodes these observability patterns into a reusable middleware layer, but the platform team should evaluate whether Powertools' tracing backend (X-Ray) matches the organization's observability platform. Organizations running Datadog or Honeycomb as their primary observability backend should wrap Powertools' tracing with a custom exporter or use a sidecar extension (Lambda Insights, Datadog Lambda Extension) that ships telemetry to the organization's backend rather than leaving it fragmented across X-Ray. The staff engineer decision is which observability backend is canonical for serverless workloads, and that decision should be made once and applied consistently, not re-litigated per service.
