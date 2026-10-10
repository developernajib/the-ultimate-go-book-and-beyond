## 102N.3 Rightsizing Recommendations

Rightsizing is the process of matching EC2 instance types and Lambda memory allocations to actual workload demands, eliminating the wasted spend that comes from over-provisioned resources. The analyzer below queries CloudWatch for CPU utilization over a configurable lookback window and applies tiered thresholds, severe underutilization (avg CPU < 5%), moderate underutilization (avg CPU < 20%), and over-utilization (avg CPU > 80%), to produce a concrete `RecommendedType` with a projected monthly savings figure. A `PricingService` interface abstracts the AWS Pricing API so the same logic can be unit-tested against stub data without live API calls.

```go
package rightsizing

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	cwtypes "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
)

// EC2Metrics collects CPU and memory utilization for rightsizing
type EC2Metrics struct {
	InstanceID     string
	InstanceType   string
	AvgCPUPercent  float64
	MaxCPUPercent  float64
	AvgMemPercent  float64 // requires CloudWatch agent
	CurrentCost    float64 // monthly
	CurrentVCPUs   int
	CurrentMemGB   float64
}

// RightsizeRecommendation suggests a more cost-effective instance type
type RightsizeRecommendation struct {
	InstanceID       string
	CurrentType      string
	RecommendedType  string
	CurrentCost      float64
	ProjectedCost    float64
	MonthlySavings   float64
	SavingsPercent   float64
	Reason           string
	Confidence       float64 // 0-1
}

// RightsizingAnalyzer analyzes instances and recommends optimal sizes
type RightsizingAnalyzer struct {
	cw        *cloudwatch.Client
	ec2Client *ec2.Client
	pricing   PricingService
}

// AnalyzeInstance analyzes a single instance
func (a *RightsizingAnalyzer) AnalyzeInstance(ctx context.Context, instanceID string, lookback time.Duration) (*RightsizeRecommendation, error) {
	metrics, err := a.collectMetrics(ctx, instanceID, lookback)
	if err != nil {
		return nil, fmt.Errorf("collect metrics for %s: %w", instanceID, err)
	}

	return a.recommend(ctx, metrics)
}

func (a *RightsizingAnalyzer) collectMetrics(ctx context.Context, instanceID string, lookback time.Duration) (*EC2Metrics, error) {
	endTime := time.Now()
	startTime := endTime.Add(-lookback)

	// Get CPU metrics from CloudWatch
	cpuOut, err := a.cw.GetMetricStatistics(ctx, &cloudwatch.GetMetricStatisticsInput{
		Namespace:  aws.String("AWS/EC2"),
		MetricName: aws.String("CPUUtilization"),
		Dimensions: []cwtypes.Dimension{
			{Name: aws.String("InstanceId"), Value: aws.String(instanceID)},
		},
		StartTime:  aws.Time(startTime),
		EndTime:    aws.Time(endTime),
		Period:     aws.Int32(3600), // 1-hour periods
		Statistics: []cwtypes.Statistic{
			cwtypes.StatisticAverage,
			cwtypes.StatisticMaximum,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get CPU metrics: %w", err)
	}

	avgCPU, maxCPU := aggregateMetrics(cpuOut.Datapoints)

	// Get instance details
	instanceOut, err := a.ec2Client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		InstanceIds: []string{instanceID},
	})
	if err != nil {
		return nil, fmt.Errorf("describe instance: %w", err)
	}

	if len(instanceOut.Reservations) == 0 || len(instanceOut.Reservations[0].Instances) == 0 {
		return nil, fmt.Errorf("instance %s not found", instanceID)
	}

	instance := instanceOut.Reservations[0].Instances[0]
	instanceType := string(instance.InstanceType)

	spec, err := a.pricing.GetInstanceSpec(ctx, instanceType)
	if err != nil {
		return nil, fmt.Errorf("get instance spec: %w", err)
	}

	return &EC2Metrics{
		InstanceID:    instanceID,
		InstanceType:  instanceType,
		AvgCPUPercent: avgCPU,
		MaxCPUPercent: maxCPU,
		CurrentCost:   spec.MonthlyCost,
		CurrentVCPUs:  spec.VCPUs,
		CurrentMemGB:  spec.MemoryGB,
	}, nil
}

func (a *RightsizingAnalyzer) recommend(ctx context.Context, metrics *EC2Metrics) (*RightsizeRecommendation, error) {
	// Rightsizing logic:
	// - If avg CPU < 5% and max CPU < 20%: instance is severely over-provisioned
	// - If avg CPU < 20% and max CPU < 50%: consider downsizing
	// - If avg CPU > 80%: consider upsizing

	var reason string
	var targetVCPUs int
	var targetMemGB float64
	confidence := 0.0

	switch {
	case metrics.AvgCPUPercent < 5 && metrics.MaxCPUPercent < 20:
		reason = fmt.Sprintf("severely underutilized (avg=%.1f%%, max=%.1f%%)", metrics.AvgCPUPercent, metrics.MaxCPUPercent)
		targetVCPUs = max(1, metrics.CurrentVCPUs/4)
		targetMemGB = max(0.5, metrics.CurrentMemGB/4)
		confidence = 0.90

	case metrics.AvgCPUPercent < 20 && metrics.MaxCPUPercent < 50:
		reason = fmt.Sprintf("underutilized (avg=%.1f%%, max=%.1f%%)", metrics.AvgCPUPercent, metrics.MaxCPUPercent)
		targetVCPUs = max(1, metrics.CurrentVCPUs/2)
		targetMemGB = max(0.5, metrics.CurrentMemGB/2)
		confidence = 0.75

	case metrics.AvgCPUPercent > 80:
		reason = fmt.Sprintf("over-utilized (avg=%.1f%%)", metrics.AvgCPUPercent)
		targetVCPUs = metrics.CurrentVCPUs * 2
		targetMemGB = metrics.CurrentMemGB * 2
		confidence = 0.85

	default:
		// Well-utilized, no recommendation
		return nil, nil
	}

	// Find best matching instance type
	recommendation, err := a.pricing.FindBestInstance(ctx, targetVCPUs, targetMemGB)
	if err != nil {
		return nil, fmt.Errorf("find instance: %w", err)
	}

	savings := metrics.CurrentCost - recommendation.MonthlyCost
	savingsPercent := 0.0
	if metrics.CurrentCost > 0 {
		savingsPercent = savings / metrics.CurrentCost * 100
	}

	return &RightsizeRecommendation{
		InstanceID:      metrics.InstanceID,
		CurrentType:     metrics.InstanceType,
		RecommendedType: recommendation.InstanceType,
		CurrentCost:     metrics.CurrentCost,
		ProjectedCost:   recommendation.MonthlyCost,
		MonthlySavings:  savings,
		SavingsPercent:  savingsPercent,
		Reason:          reason,
		Confidence:      confidence,
	}, nil
}

func aggregateMetrics(datapoints []cwtypes.Datapoint) (avg, max float64) {
	if len(datapoints) == 0 {
		return 0, 0
	}
	sum := 0.0
	for _, dp := range datapoints {
		if dp.Average != nil {
			sum += *dp.Average
		}
		if dp.Maximum != nil && *dp.Maximum > max {
			max = *dp.Maximum
		}
	}
	avg = sum / float64(len(datapoints))
	return avg, max
}

func maxF(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// PricingService interface for instance pricing
type PricingService interface {
	GetInstanceSpec(ctx context.Context, instanceType string) (*InstanceSpec, error)
	FindBestInstance(ctx context.Context, vcpus int, memGB float64) (*InstanceSpec, error)
}

type InstanceSpec struct {
	InstanceType string
	VCPUs        int
	MemoryGB     float64
	MonthlyCost  float64
}

// LambdaRightsizing analyzes Lambda function configurations
type LambdaRightsizing struct {
	cw *cloudwatch.Client
}

type LambdaMetrics struct {
	FunctionName    string
	MemoryMB        int
	AvgDurationMS   float64
	MaxDurationMS   float64
	AvgMemUsedMB    float64 // from X-Ray or custom metrics
	MonthlyInvokes  int64
	MonthlyCost     float64
}

type LambdaRecommendation struct {
	FunctionName       string
	CurrentMemoryMB    int
	RecommendedMemMB   int
	CurrentCost        float64
	ProjectedCost      float64
	MonthlySavings     float64
	DurationChangeMS   float64
	Reason             string
}

// AnalyzeLambda recommends optimal memory settings
// Note: Lambda pricing = duration × memory - lower memory = slower but cheaper (sometimes)
// Power tuning: AWS Lambda Power Tuning tool helps find optimal memory
func (r *LambdaRightsizing) AnalyzeLambda(ctx context.Context, functionName string) (*LambdaRecommendation, error) {
	// Get Lambda metrics from CloudWatch
	endTime := time.Now()
	startTime := endTime.AddDate(0, 0, -14) // 14 days

	// Duration metrics
	durationOut, err := r.cw.GetMetricStatistics(ctx, &cloudwatch.GetMetricStatisticsInput{
		Namespace:  aws.String("AWS/Lambda"),
		MetricName: aws.String("Duration"),
		Dimensions: []cwtypes.Dimension{
			{Name: aws.String("FunctionName"), Value: aws.String(functionName)},
		},
		StartTime:  aws.Time(startTime),
		EndTime:    aws.Time(endTime),
		Period:     aws.Int32(86400), // daily
		Statistics: []cwtypes.Statistic{cwtypes.StatisticAverage, cwtypes.StatisticMaximum},
	})
	if err != nil {
		return nil, fmt.Errorf("get duration metrics: %w", err)
	}

	avgDuration, maxDuration := aggregateMetrics(durationOut.Datapoints)

	// Lambda cost calculation
	// Cost = (invocations × $0.20/million) + (duration × memory × $0.0000000167/GB-second)
	// Simplified for recommendation
	const gbSecondCost = 0.0000166667
	const invokeCost = 0.20 / 1_000_000

	// If memory is much higher than needed, recommend reduction
	// This is simplified - real analysis requires memory usage metrics
	_ = avgDuration
	_ = maxDuration
	_ = gbSecondCost
	_ = invokeCost

	return &LambdaRecommendation{
		FunctionName: functionName,
		Reason:       "analyze with AWS Lambda Power Tuning for precise recommendations",
	}, nil
}
```

---

### Junior → FAANG: Rightsizing as a Concrete Cost Reduction Skill

The rightsizing analyzer in this section is more valuable as a learning artifact than as a production tool: it shows the data flow (CloudWatch metrics to utilization summary to recommendation to savings estimate) that all rightsizing tools use. Understanding this data flow lets you evaluate commercial rightsizing tools (AWS Compute Optimizer, Spot.io, Densify) critically rather than accepting their recommendations at face value.

The CPU utilization thresholds in this section (5% for severe underutilization, 20% for moderate) are starting points, not universal standards. A service that is CPU-bound for one hour per day during batch processing but idle the remaining 23 hours will show 4% average CPU utilization and trigger a downsize recommendation. Downsizing it would cause batch processing to exceed its time budget. The correct metric is peak CPU utilization, not average. Before acting on any rightsizing recommendation, check the utilization histogram, not just the average.

### Senior @ FAANG: Rightsizing Program as a Platform Engineering Deliverable

At staff level, rightsizing is a fleet-wide program, not a per-service optimization. The program has three components: automated recommendation generation (running the analyzer in this section on a schedule), recommendation delivery (pushing recommendations to team channels with projected savings and the utilization data supporting the recommendation), and recommendation tracking (monitoring whether teams act on recommendations and measuring the savings realized).

The recommendation delivery mechanism determines adoption rate. Recommendations sent to a shared FinOps Slack channel have low adoption because they lack the team context to create accountability. Recommendations sent to the team's own channel, tagged with the service name and the engineer who owns the service, with a one-click link to the CloudWatch utilization chart, have high adoption because they are actionable without additional research.

The savings tracking component is the organizational justification for the program: if rightsizing recommendations generate $50K/month in realized savings and the platform team spends 0.5 FTE maintaining the program, the ROI is approximately 10x (assuming $600K FTE cost). This ROI argument funds the program's continuation and justifies investment in improving recommendation quality (adding memory utilization, network utilization, and database connection pool utilization to the recommendation model). Building the savings tracking before the program launches means the ROI data is available from day one rather than being retrofitted after the fact.
