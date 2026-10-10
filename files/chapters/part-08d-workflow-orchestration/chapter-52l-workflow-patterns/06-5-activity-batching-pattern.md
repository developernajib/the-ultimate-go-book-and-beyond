## 5. Activity Batching Pattern

Calling an external API once per item creates unnecessary round-trip overhead and risks hitting rate limits. Activity batching groups multiple items into a single activity call, reducing the number of Temporal history events and external API requests. This is particularly important for notification systems, where sending 10,000 individual emails as separate activities would generate 10,000 history entries and overwhelm both Temporal and the email provider.

The implementation below shows two batching strategies. The first groups notifications by delivery channel (email, SMS, push) and sends each channel's batch as a single activity, with sub-batching inside the activity to respect per-API limits. The `RecordHeartbeat` calls prevent Temporal from timing out long-running batch activities. The second strategy, `WindowedBatchWorkflow`, collects items arriving via signal over a configurable time window, then processes them all at once when the window closes.

```go
package batching

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/workflow"
)

// NotificationRequest represents a single notification
type NotificationRequest struct {
	UserID  string
	Type    string
	Message string
	Channel string // email, sms, push
}

// BatchNotificationResult aggregates batch results
type BatchNotificationResult struct {
	Sent     int
	Failed   int
	Failures []string
}

// NotificationBatchActivities handles batched notifications
type NotificationBatchActivities struct {
	emailClient interface {
		SendBatch(ctx context.Context, notifications []NotificationRequest) error
	}
	smsClient interface {
		SendBatch(ctx context.Context, notifications []NotificationRequest) error
	}
	pushClient interface {
		SendBatch(ctx context.Context, notifications []NotificationRequest) error
	}
}

// SendEmailBatch sends a batch of email notifications
func (a *NotificationBatchActivities) SendEmailBatch(
	ctx context.Context,
	notifications []NotificationRequest,
) (BatchNotificationResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Sending email batch", "count", len(notifications))

	result := BatchNotificationResult{}

	// Process in sub-batches of 100 (typical email API limit)
	const subBatchSize = 100
	for i := 0; i < len(notifications); i += subBatchSize {
		end := min(i+subBatchSize, len(notifications))
		subBatch := notifications[i:end]

		if err := a.emailClient.SendBatch(ctx, subBatch); err != nil {
			result.Failed += len(subBatch)
			result.Failures = append(result.Failures,
				fmt.Sprintf("sub-batch %d-%d: %v", i, end, err))
		} else {
			result.Sent += len(subBatch)
		}

		// Heartbeat to prevent timeout on large batches
		activity.RecordHeartbeat(ctx, fmt.Sprintf("processed %d/%d", end, len(notifications)))
	}

	return result, nil
}

// SendSMSBatch sends a batch of SMS notifications
func (a *NotificationBatchActivities) SendSMSBatch(
	ctx context.Context,
	notifications []NotificationRequest,
) (BatchNotificationResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Sending SMS batch", "count", len(notifications))

	// SMS typically has lower rate limits
	result := BatchNotificationResult{}
	const subBatchSize = 25

	for i := 0; i < len(notifications); i += subBatchSize {
		end := min(i+subBatchSize, len(notifications))

		if err := a.smsClient.SendBatch(ctx, notifications[i:end]); err != nil {
			result.Failed += end - i
		} else {
			result.Sent += end - i
		}

		activity.RecordHeartbeat(ctx, fmt.Sprintf("SMS processed %d/%d", end, len(notifications)))
		// Respect rate limits
		time.Sleep(100 * time.Millisecond)
	}

	return result, nil
}

// BatchNotificationWorkflow groups notifications by channel and sends in batches
func BatchNotificationWorkflow(ctx workflow.Context, notifications []NotificationRequest) (BatchNotificationResult, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting batch notification workflow", "total", len(notifications))

	// Group notifications by channel
	channelGroups := map[string][]NotificationRequest{
		"email": {},
		"sms":   {},
		"push":  {},
	}

	for _, n := range notifications {
		channelGroups[n.Channel] = append(channelGroups[n.Channel], n)
	}

	// Launch parallel batches per channel
	type channelResult struct {
		channel string
		result  BatchNotificationResult
		err     error
	}

	results := make(map[string]BatchNotificationResult)

	// Execute batches in parallel using futures
	type channelFuture struct {
		channel string
		future  workflow.Future
	}

	var futures []channelFuture

	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	if emails := channelGroups["email"]; len(emails) > 0 {
		logger.Info("Queuing email batch", "count", len(emails))
		futures = append(futures, channelFuture{
			channel: "email",
			future: workflow.ExecuteActivity(ctx,
				(*NotificationBatchActivities)(nil).SendEmailBatch, emails),
		})
	}

	if sms := channelGroups["sms"]; len(sms) > 0 {
		logger.Info("Queuing SMS batch", "count", len(sms))
		futures = append(futures, channelFuture{
			channel: "sms",
			future: workflow.ExecuteActivity(ctx,
				(*NotificationBatchActivities)(nil).SendSMSBatch, sms),
		})
	}

	// Collect results
	totalResult := BatchNotificationResult{}

	for _, cf := range futures {
		var batchResult BatchNotificationResult
		if err := cf.future.Get(ctx, &batchResult); err != nil {
			logger.Error("Batch failed", "channel", cf.channel, "error", err)
			results[cf.channel] = BatchNotificationResult{
				Failed: len(channelGroups[cf.channel]),
			}
		} else {
			results[cf.channel] = batchResult
		}

		totalResult.Sent += results[cf.channel].Sent
		totalResult.Failed += results[cf.channel].Failed
		totalResult.Failures = append(totalResult.Failures, results[cf.channel].Failures...)
	}

	logger.Info("Batch notification completed",
		"sent", totalResult.Sent,
		"failed", totalResult.Failed)

	return totalResult, nil
}

// WindowedBatchWorkflow collects items over a time window then processes as batch
func WindowedBatchWorkflow(ctx workflow.Context, windowDuration time.Duration) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting windowed batch workflow", "window", windowDuration)

	itemsCh := workflow.GetSignalChannel(ctx, "batch-item")
	var items []string

	// Collect items during window
	timer := workflow.NewTimer(ctx, windowDuration)
	selector := workflow.NewSelector(ctx)

	timerFired := false
	selector.AddFuture(timer, func(f workflow.Future) {
		timerFired = true
	})

	selector.AddReceive(itemsCh, func(c workflow.ReceiveChannel, more bool) {
		var item string
		c.Receive(ctx, &item)
		items = append(items, item)
	})

	for !timerFired {
		selector.Select(ctx)
		// Drain any buffered items
		for {
			var item string
			if ok := itemsCh.ReceiveAsync(&item); !ok {
				break
			}
			items = append(items, item)
		}
	}

	logger.Info("Window closed, processing batch", "itemCount", len(items))

	if len(items) == 0 {
		return nil
	}

	// Process accumulated batch
	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	return workflow.ExecuteActivity(ctx, ProcessBatchActivity, items).Get(ctx, nil)
}

func ProcessBatchActivity(ctx context.Context, items []string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Processing batch", "itemCount", len(items))
	return nil
}
```

### Junior → FAANG: Why Batching Matters and When to Apply It

Activity batching is a performance pattern that junior engineers often skip because the naive implementation (one activity per item) works correctly at low volume. The problems appear at scale: 10,000 individual email activities generate 30,000 history events, saturate the Temporal task queue, and call the email API 10,000 times instead of 100 times.

**The two dimensions batching optimizes.** First, Temporal history size: batching N items into one activity reduces history events by a factor of N. Second, external API call count: batching reduces rate-limit pressure and network round-trip overhead. Both matter independently. Even if the external API has no rate limit, reducing history events from 30,000 to 300 significantly improves replay performance for long-running workflows.

**Heartbeating is mandatory for long-running batch activities.** The `activity.RecordHeartbeat` calls in the email batch function prevent Temporal from timing out the activity mid-execution. If the activity processes 10,000 emails over 5 minutes and the `HeartbeatTimeout` is set to 30 seconds, the activity will be timed out unless it heartbeats at least every 30 seconds. Set `HeartbeatTimeout` to roughly 2x your heartbeat interval, and heartbeat after each sub-batch.

**The windowed batch is for event-driven aggregation, not for known inputs.** `WindowedBatchWorkflow` applies when items arrive unpredictably over time (via signals) and you want to process them as a batch when either a time window closes or a count threshold is reached. It is the correct model for aggregating CDC events, user action streams, or IoT sensor readings. It is wrong for processing a known list of items: use the static fan-out or the per-channel batch pattern for those.

**Sub-batch sizing is an external API contract, not a Temporal concept.** The 100-email and 25-SMS sub-batch sizes in the example come from the email and SMS providers' API limits, not from Temporal constraints. Always read the provider's rate-limit and batch-size documentation before choosing sub-batch sizes, and make those limits configurable rather than hardcoded.

### Senior @ FAANG: Batching Architecture, Backpressure, and Adaptive Sizing

At staff level, batching is not a local optimization. It is part of the throughput and backpressure design for an entire pipeline. The decisions made at the batching layer propagate up to capacity planning and SLA definitions.

**Batch size as a throughput-latency trade-off.** A larger batch reduces overhead per item but increases the wait time for the last item added to the batch. In the windowed batch model, items arriving just before the window closes wait for the entire window duration. If SLA requires "process within 60 seconds of arrival," a 5-minute window violates the SLA for most items. The correct window size is derived from the SLA, not from operational convenience. Document this derivation in the ADR: "window = max(SLA_budget / 2, minimum_batch_efficiency_threshold)."

**Adaptive batching for variable throughput.** Fixed windows are inefficient at low throughput (the window closes with only a few items, wasting the benefit of batching) and potentially SLA-violating at high throughput (items queue up waiting for the window). Adaptive batching adjusts the window based on arrival rate: at low arrival rates, flush early when count reaches a low threshold, and at high arrival rates, extend the window slightly to maximize batch efficiency. Implementing this in a Temporal workflow requires a selector that races a count-threshold signal against a maximum-wait timer, with the flush threshold parameterized.

**Batching and partial failure semantics.** When a sub-batch of 100 emails fails, the batch activity retries the entire sub-batch, not individual items. This is correct only if the email provider's batch API is idempotent (re-sending the same batch does not send duplicate emails). If the provider lacks idempotency, the activity must track which items in the sub-batch were sent before the failure and skip them on retry. This requires the activity to store partial progress, which is the heartbeat payload's correct use: serialize the last successfully processed offset into the heartbeat, and on retry reconstruct from that offset.

**Interaction with Temporal's event sourcing model.** The batch activity itself is a single Temporal event. If the batch activity fails and retries, Temporal records the retry but not the individual items within the batch. This means batch-level retries are correct from Temporal's perspective, but item-level retry granularity is the activity's internal concern. Staff engineers designing batch pipelines must specify this granularity explicitly: "retry the entire sub-batch" versus "skip failed items and report them" versus "pause the pipeline and alert on-call."

**Rate-limit-aware batching as a system-level contract.** In a multi-tenant system, different workflow instances may all be sending email batches simultaneously. Without rate limiting at the system level, concurrent batch activities can collectively exceed the email provider's rate limit even if each individual batch respects the sub-batch size. The solution is a rate-limiter activity that acquires tokens before each sub-batch call, backed by a shared rate-limit service (Redis token bucket, or a dedicated rate-limiter workflow that serializes access). This system-level rate limiting is an architectural decision that belongs in the platform team's workflow standard library, not in each individual workflow.

**History event reduction as a deployment metric.** When evaluating whether a batching migration was successful, measure the reduction in Temporal history events per processed item before and after. A 10x reduction in history events translates directly to faster replay times, smaller storage costs, and higher workflow throughput. Track this metric in the deployment runbook alongside the correctness metrics (delivery count, error rate, SLA compliance).

---
