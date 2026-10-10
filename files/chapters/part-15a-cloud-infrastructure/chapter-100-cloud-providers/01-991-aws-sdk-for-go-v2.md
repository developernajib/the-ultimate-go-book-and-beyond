## 100.1 AWS SDK for Go v2

### SDK Overview

AWS SDK for Go v2 is a ground-up rewrite that abandons the monolithic v1 module in favour of per-service packages, so `go get github.com/aws/aws-sdk-go-v2/service/s3` pulls only the S3 client rather than every AWS service. The redesign makes `context.Context` a first-class parameter on every API call, enabling proper request cancellation and deadline propagation across concurrent goroutines. The middleware stack replaces v1's request/response hooks with a composable chain that lets you inject retries, signing, and observability instrumentation without forking SDK internals.

```
┌──────────────────────────────────────────────────────────────────┐
│                    AWS SDK FOR GO v2                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  IMPROVEMENTS OVER v1:                                           │
│  ├── Modular packages (import only what you need)                │
│  ├── Improved performance                                        │
│  ├── Better middleware support                                   │
│  ├── Context-first API design                                    │
│  └── Enhanced configuration                                      │
│                                                                  │
│  INSTALLATION:                                                   │
│  go get github.com/aws/aws-sdk-go-v2                             │
│  go get github.com/aws/aws-sdk-go-v2/config                      │
│  go get github.com/aws/aws-sdk-go-v2/service/s3                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Configuration

`config.LoadDefaultConfig` resolves credentials through a priority chain, environment variables first, then `~/.aws/credentials`, then an EC2/ECS instance metadata role, so the same binary works on a developer laptop and in production without code changes. When running in a cross-account scenario, `WithSharedConfigProfile` selects a named profile that may include an `role_arn` entry, causing the SDK to call `sts:AssumeRole` transparently before signing requests. Static credentials via `NewStaticCredentialsProvider` are useful in tests and local development but should never be shipped to production where IAM roles provide automatic rotation.

```go
package main

import (
    "context"
    "log"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/credentials"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

func main() {
    ctx := context.Background()

    // Load default configuration
    // Checks: env vars, shared config, IAM role
    cfg, err := config.LoadDefaultConfig(ctx,
        config.WithRegion("us-west-2"),
    )
    if err != nil {
        log.Fatalf("unable to load SDK config: %v", err)
    }

    // Create S3 client
    client := s3.NewFromConfig(cfg)

    // List buckets
    result, err := client.ListBuckets(ctx, &s3.ListBucketsInput{})
    if err != nil {
        log.Fatalf("failed to list buckets: %v", err)
    }

    for _, bucket := range result.Buckets {
        log.Printf("Bucket: %s, Created: %s\n",
            *bucket.Name, bucket.CreationDate)
    }
}

// Custom credentials configuration
func configWithCredentials() {
    ctx := context.Background()

    cfg, err := config.LoadDefaultConfig(ctx,
        config.WithRegion("us-west-2"),
        config.WithCredentialsProvider(
            credentials.NewStaticCredentialsProvider(
                "AKID",
                "SECRET",
                "SESSION",
            ),
        ),
    )
    if err != nil {
        log.Fatal(err)
    }

    _ = cfg
}

// Assume role configuration
func configWithAssumeRole() {
    ctx := context.Background()

    cfg, err := config.LoadDefaultConfig(ctx,
        config.WithRegion("us-west-2"),
        config.WithSharedConfigProfile("my-profile"),
    )
    if err != nil {
        log.Fatal(err)
    }

    _ = cfg
}
```

---

### Junior → FAANG: AWS SDK v2 Fundamentals and Go Idioms

The AWS SDK v2 represents a significant redesign from v1. The key differences: configuration is explicit (no global state, each client is created with a config), context propagation is required on every API call (enabling timeout and cancellation), and the SDK uses the functional options pattern for request configuration. These are all idiomatic Go patterns.

The credential chain is the most important concept to understand early: the SDK tries several credential sources in order (environment variables, shared credentials file, IAM instance profile, ECS task role, assumed role). In production, the correct source is the IAM role associated with the ECS task or EC2 instance, not environment variables or credentials files. Understanding this chain prevents the common mistake of shipping an application that works locally (using environment variables) but fails in production (where the expected IAM role is not configured correctly).

First-job habit: always use the AWS SDK's built-in retry logic with customized backoff for production code. The default retry behavior is suitable for most cases, but understanding when to increase the retry count (eventual consistency scenarios like DynamoDB GSI propagation) and when to decrease it (latency-sensitive operations where a slow AWS call should fail fast) is important.

### Senior @ FAANG: AWS SDK at Scale and Cost Management

At staff level, AWS SDK usage is a cost management and reliability problem. Each AWS API call has a cost (some services charge per API call, others have per-GB transfer costs), a rate limit (requests per second per account and per region), and latency characteristics that affect application performance.

The specific senior concerns: DynamoDB throughput management (on-demand versus provisioned capacity mode, the cost model of each, and how to right-size provisioned capacity using CloudWatch metrics), S3 request rate management (S3 has prefix-based throughput partitioning, poorly designed key patterns create hot partitions), SQS polling efficiency (long polling versus short polling, the cost of empty polls in a low-traffic system), and Lambda cold start management (the cold start latency is directly affected by the binary size and the initialization work done outside the handler function).

The architectural pattern for AWS SDK at scale is a service wrapper that centralizes configuration (retry policy, timeout, instrumentation) rather than each team configuring the SDK independently. This wrapper is owned by the platform team, includes standard OpenTelemetry instrumentation for every API call, enforces organization-level timeout policies, and integrates with the cost attribution system (tagging API calls with the service and team that made them). Building this wrapper and driving adoption across the engineering organization is an L6/L7 platform engineering contribution.
