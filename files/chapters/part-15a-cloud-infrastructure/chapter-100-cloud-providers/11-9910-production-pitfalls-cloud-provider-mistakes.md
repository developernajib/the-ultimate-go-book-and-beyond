## 100.11 Production Pitfalls: Cloud Provider Mistakes

### Pitfall 1: Hardcoding Cloud Credentials

**Real Incident Report**: A developer committed AWS credentials to a public GitHub repository. Within 3 minutes, automated bots detected them, and crypto miners spun up $50,000 worth of EC2 instances before the team noticed. AWS credentials were in git history even after the file was deleted.

**The Anti-Pattern**:
```go
// WRONG: Hardcoded credentials
client := s3.NewFromConfig(aws.Config{
    Credentials: aws.NewStaticCredentialsProvider(
        "AKIAIOSFODNN7EXAMPLE",    // Leaked!
        "wJalrXUtnFEMI/K7MDENG",   // Leaked!
        "",
    ),
})
```

**The Better Approach**:
```go
// RIGHT: Use default credential chain
cfg, err := config.LoadDefaultConfig(context.Background())
if err != nil {
    log.Fatal(err)
}
client := s3.NewFromConfig(cfg)

// Credentials resolved from (in order):
// 1. Environment variables (AWS_ACCESS_KEY_ID, etc.)
// 2. Shared credentials file (~/.aws/credentials)
// 3. IAM role (on EC2, ECS, Lambda, etc.)
// 4. Web identity token (EKS, GitHub Actions OIDC)
```

**Key Insight**: Never hardcode credentials. Use IAM roles for services and the default credential chain for development.

### Pitfall 2: Not Handling API Rate Limits

**Real Incident Report**: A service made thousands of DynamoDB requests per second without rate limiting. During a traffic spike, it hit AWS service quotas, causing `ProvisionedThroughputExceededException`. The app had no retry logic and returned 500s to users.

**The Anti-Pattern**:
```go
// WRONG: No retry or rate limit handling
func getData(ctx context.Context, key string) ([]byte, error) {
    out, err := client.GetItem(ctx, &dynamodb.GetItemInput{
        TableName: aws.String("my-table"),
        Key:       map[string]types.AttributeValue{"id": &types.AttributeValueMemberS{Value: key}},
    })
    if err != nil {
        return nil, err  // Fails on throttling
    }
    return marshal(out.Item)
}
```

**The Better Approach**:
```go
// RIGHT: With exponential backoff and jitter
func getData(ctx context.Context, key string) ([]byte, error) {
    cfg, _ := config.LoadDefaultConfig(ctx,
        config.WithRetryer(func() aws.Retryer {
            return retry.AddWithMaxAttempts(
                retry.NewStandard(func(o *retry.StandardOptions) {
                    o.MaxAttempts = 5
                    o.Backoff = retry.NewExponentialJitterBackoff(32 * time.Second)
                }),
                5,
            )
        }),
    )
    client := dynamodb.NewFromConfig(cfg)

    out, err := client.GetItem(ctx, &dynamodb.GetItemInput{
        TableName: aws.String("my-table"),
        Key:       map[string]types.AttributeValue{"id": &types.AttributeValueMemberS{Value: key}},
    })
    if err != nil {
        return nil, err
    }
    return marshal(out.Item)
}
```

**Key Insight**: All cloud APIs have rate limits. Build in retries with exponential backoff and jitter, or use SDKs that handle this automatically.

### Pitfall 3: Single-Region Architecture

**Real Incident Report**: A company ran everything in us-east-1. When AWS had a major us-east-1 outage, their entire platform was down for 4 hours. Customers couldn't access the service, and there was no failover. The outage cost more than multi-region would have cost for 5 years.

**The Anti-Pattern**:
- All resources in one region
- No failover mechanism
- Single point of failure in cloud provider
- No business continuity plan

**The Better Approach**:
```go
// Multi-region client configuration
type MultiRegionClient struct {
    primary   *s3.Client
    secondary *s3.Client
    fallback  bool
}

func NewMultiRegionClient(ctx context.Context) (*MultiRegionClient, error) {
    primaryCfg, _ := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
    secondaryCfg, _ := config.LoadDefaultConfig(ctx, config.WithRegion("us-west-2"))

    return &MultiRegionClient{
        primary:   s3.NewFromConfig(primaryCfg),
        secondary: s3.NewFromConfig(secondaryCfg),
    }, nil
}

func (c *MultiRegionClient) GetObject(ctx context.Context, key string) ([]byte, error) {
    client := c.primary
    if c.fallback {
        client = c.secondary
    }

    out, err := client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: aws.String("my-bucket"),
        Key:    aws.String(key),
    })
    if err != nil {
        // Try secondary on primary failure
        if !c.fallback {
            c.fallback = true
            return c.GetObject(ctx, key)
        }
        return nil, err
    }
    return io.ReadAll(out.Body)
}
```

**Key Insight**: Major cloud outages happen. Multi-region isn't about 100% uptime - it's about surviving the inevitable regional failures.

### Pitfall 4: Not Using Cloud-Native Features

**Real Incident Report**: A team ran cron jobs in Kubernetes to process SQS messages. When pods crashed, messages were lost. They didn't know SQS has dead-letter queues, visibility timeouts, and long polling - features that would have prevented data loss without custom code.

**The Anti-Pattern**:
```go
// WRONG: Reinventing what the cloud provides
func processMessages() {
    for {
        // Custom polling loop
        msgs, _ := sqs.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
            QueueUrl:        aws.String(queueURL),
            WaitTimeSeconds: 0,  // No long polling
        })
        for _, msg := range msgs.Messages {
            process(msg)  // No error handling
            sqs.DeleteMessage(ctx, &sqs.DeleteMessageInput{
                QueueUrl:      aws.String(queueURL),
                ReceiptHandle: msg.ReceiptHandle,
            })
        }
        time.Sleep(1 * time.Second)  // Inefficient polling
    }
}
```

**The Better Approach**:
```go
// RIGHT: Use cloud-native features
func processMessages() {
    for {
        msgs, err := sqs.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
            QueueUrl:            aws.String(queueURL),
            MaxNumberOfMessages: 10,           // Batch processing
            WaitTimeSeconds:     20,           // Long polling (reduces costs)
            VisibilityTimeout:   60,           // Time to process before redelivery
        })
        if err != nil {
            log.Printf("receive error: %v", err)
            continue
        }

        for _, msg := range msgs.Messages {
            if err := process(msg); err != nil {
                // Don't delete - will go to DLQ after max receives
                log.Printf("process error: %v", err)
                continue
            }
            sqs.DeleteMessage(ctx, &sqs.DeleteMessageInput{
                QueueUrl:      aws.String(queueURL),
                ReceiptHandle: msg.ReceiptHandle,
            })
        }
    }
}

// Configure DLQ in Terraform/CloudFormation:
// RedrivePolicy: {"deadLetterTargetArn": dlq_arn, "maxReceiveCount": 3}
```

**Key Insight**: Cloud services have years of engineering built in. Use features like DLQs, auto-scaling, and managed retries instead of reinventing them.

### Pitfall 5: Ignoring Cost Until the Bill Arrives

**Real Incident Report**: A team used the highest-performance DynamoDB provisioning "to be safe." Monthly bill: $25,000. After analysis, they discovered 90% of their tables were barely used. Switching to on-demand for low-traffic tables reduced the bill to $3,000.

**The Anti-Pattern**:
- Provisioning for peak at all times
- Never reviewing usage
- Using premium tiers without justification
- No cost alerts

**The Better Approach**:
```go
// Cost-aware infrastructure decisions

// 1. Use appropriate service tiers
// Low traffic: Lambda, Fargate Spot, DynamoDB on-demand
// High traffic: EC2, provisioned capacity

// 2. Set up cost alerts (Terraform example)
/*
resource "aws_budgets_budget" "monthly" {
  budget_type  = "COST"
  limit_amount = "5000"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator = "GREATER_THAN"
    threshold           = 80  # Alert at 80% of budget
    threshold_type      = "PERCENTAGE"
    notification_type   = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }
}
*/

// 3. Use spot/preemptible for non-critical workloads
// 4. Implement auto-scaling that scales DOWN, not just up
// 5. Review AWS Cost Explorer monthly
```

**Key Insight**: Cloud costs are unbounded by default. Set budgets, review regularly, and right-size from the start.

### Quick Reference: Cloud Provider Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Hardcoded credentials | $50K crypto mining bill | IAM roles, default credential chain |
| No rate limit handling | Throttling → user errors | Exponential backoff, SDK retries |
| Single region | Regional outage = total outage | Multi-region, failover mechanisms |
| Reinventing features | Data loss, complexity | Use cloud-native (DLQ, long polling) |
| Ignoring costs | $25K surprise bill | Budgets, alerts, right-sizing |
| No encryption | Compliance violations | Default to encryption at rest and transit |

---

### Junior → FAANG: Cloud Pitfalls That Become Career-Defining Mistakes

The pitfalls in this list are not theoretical. Hardcoded credentials checked into public GitHub repositories trigger automated credential rotation at FAANG companies within minutes of exposure, but the exposure window is real and the post-incident process is unpleasant. Publicly accessible S3 buckets with sensitive data have caused some of the most embarrassing and costly data breaches in recent memory.

The two pitfalls to internalize as absolute rules, not guidelines: never hardcode cloud credentials, and never make a storage bucket public unless you have explicitly verified that every object in it is intended for public access. Both are non-negotiable, and both have zero legitimate exceptions in a production engineering environment.

The other pitfalls (missing rate limiting, no retry logic, wrong region) produce operational problems rather than security incidents. They matter, but they are fixable. A credential exposure is not.

### Senior @ FAANG: Cloud Pitfall Prevention Through Platform Controls

At staff level, the cloud pitfalls list is a checklist for organizational controls. Each pitfall should have a corresponding automated prevention mechanism that catches the violation before it reaches production or causes a security incident.

Hardcoded credentials: detected by secret scanning in CI (git-secrets, gitleaks, trufflehog) and by cloud provider credential scanners on public repositories. Publicly accessible buckets: detected by cloud security posture management (CSPM) tools (AWS Security Hub, GCP Security Command Center) that continuously audit storage bucket configurations. Missing rate limiting: detected by API usage monitoring that alerts when an account approaches service quotas. No retry logic: harder to detect statically but visible in production via increased error rates on cloud API calls during provider-side throttling events.

The organizational control that provides the broadest coverage is a CSPM tool that continuously audits the cloud account configuration against a baseline policy and alerts on deviations. At FAANG scale, this tool is evaluated and configured by the platform security team, and its alerts flow into the incident management system with defined SLAs for remediation. Designing this control infrastructure and ensuring it covers the most critical pitfall categories is an L6/L7 security engineering contribution.
