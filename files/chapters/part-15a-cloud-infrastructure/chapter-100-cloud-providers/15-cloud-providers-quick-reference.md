## 100.15 Cloud Providers Quick Reference

This reference card condenses the most frequently needed Go SDK snippets and service mappings for AWS and GCP into a single scannable table. Credential resolution order determines which identity a client assumes when no explicit credentials are supplied, so understanding the lookup chain is critical for writing code that behaves correctly both in local development and in production IAM-role-based deployments. Presigned URL generation and paginator patterns are highlighted because they are the most common source of subtle bugs when teams switch between cloud providers.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CLOUD PROVIDERS QUICK REFERENCE                            │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  SDK INITIALIZATION                                                           │
│  ─────────────────────────────────────────────────────────────────────────    │
│  AWS:  cfg, _ := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))│
│        client := s3.NewFromConfig(cfg)                                        │
│                                                                               │
│  GCP:  client, _ := storage.NewClient(ctx)                                    │
│        // Uses GOOGLE_APPLICATION_CREDENTIALS env var                         │
│                                                                               │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  SERVICE EQUIVALENTS                                                          │
│  ─────────────────────────────────────────────────────────────────────────    │
│  Category        AWS                  GCP                                     │
│  Object Storage  S3                   Cloud Storage                           │
│  NoSQL DB        DynamoDB             Firestore / Bigtable                    │
│  SQL DB          RDS / Aurora         Cloud SQL                               │
│  Messaging       SQS / SNS            Pub/Sub                                 │
│  Serverless      Lambda               Cloud Functions / Cloud Run             │
│  Containers      ECS / EKS            Cloud Run / GKE                         │
│  CDN             CloudFront           Cloud CDN                               │
│  DNS             Route 53             Cloud DNS                               │
│  Secrets         Secrets Manager      Secret Manager                          │
│  IAM             IAM                  IAM                                     │
│                                                                               │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  CREDENTIAL RESOLUTION ORDER                                                  │
│  ─────────────────────────────────────────────────────────────────────────    │
│  AWS:                                                                         │
│    1. Environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)                  │
│    2. Shared credentials (~/.aws/credentials)                                 │
│    3. IAM role (EC2, ECS, Lambda)                                             │
│    4. Web identity token (EKS OIDC)                                           │
│                                                                               │
│  GCP:                                                                         │
│    1. Environment (GOOGLE_APPLICATION_CREDENTIALS)                            │
│    2. gcloud CLI credentials                                                  │
│    3. Service account (GCE, Cloud Run, GKE)                                   │
│    4. Workload identity (GKE)                                                 │
│                                                                               │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  COMMON PATTERNS                                                              │
│  ─────────────────────────────────────────────────────────────────────────    │
│                                                                               │
│  Presigned URLs (direct upload/download):                                     │
│    AWS: presignClient.PresignPutObject(..., s3.WithPresignExpires(15*min))    │
│    GCP: bucket.SignedURL(key, &storage.SignedURLOptions{...})                 │
│                                                                               │
│  Pagination:                                                                  │
│    AWS: paginator := s3.NewListObjectsV2Paginator(client, input)              │
│         for paginator.HasMorePages() { page, _ = paginator.NextPage(ctx) }    │
│    GCP: it := bucket.Objects(ctx, query)                                      │
│         for { attrs, err := it.Next(); if err == iterator.Done { break } }    │
│                                                                               │
│  Retry with backoff:                                                          │
│    AWS: config.WithRetryer(func() aws.Retryer { return retry.NewStandard() }) │
│    GCP: option.WithGRPCDialOption(grpc.WithRetry(...))                        │
│                                                                               │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  BEST PRACTICES                                                               │
│  ─────────────────────────────────────────────────────────────────────────    │
│  □ Initialize clients once (reuse connections)                                │
│  □ Use context for cancellation and timeouts                                  │
│  □ Handle pagination for list operations                                      │
│  □ Implement exponential backoff for retries                                  │
│  □ Use IAM roles, not static credentials                                      │
│  □ Enable encryption at rest and in transit                                   │
│  □ Set up budget alerts and cost monitoring                                   │
│  □ Use multi-region for critical workloads                                    │
│  □ Implement circuit breakers for cloud calls                                 │
│  □ Log all cloud operations for debugging                                     │
│                                                                               │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  COST OPTIMIZATION                                                            │
│  ─────────────────────────────────────────────────────────────────────────    │
│  □ Use Spot/Preemptible for non-critical workloads (70-90% savings)           │
│  □ Right-size instances based on actual usage                                 │
│  □ Use reserved capacity for predictable workloads                            │
│  □ Enable S3 Intelligent-Tiering / GCS Autoclass                              │
│  □ Delete unused resources (snapshots, IPs, load balancers)                   │
│  □ Use serverless for variable workloads                                      │
│  □ Implement auto-scaling that scales DOWN                                    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

**Next Chapter: Kubernetes Operators** - Building custom Kubernetes operators using controller-runtime and kubebuilder.

### Junior → FAANG: Quick Reference as On-Call Resource

Quick reference cards are most valuable during on-call incidents when you need to write a correct API call quickly without re-reading documentation. Bookmark this page, keep a browser tab open to the AWS SDK v2 and GCP client library documentation, and practice writing the most common operations from memory until they are automatic.

The credential resolution order table is worth memorizing. In a well-configured production environment, you should never need to specify credentials explicitly: the SDK finds them automatically from the instance metadata service or the GKE metadata server. When credentials are not found, the error message usually identifies which sources were tried and which failed, making debugging straightforward.

### Senior @ FAANG: Quick Reference as Platform Standards Documentation

At staff level, a quick reference like this one is the surface manifestation of platform standards. The patterns shown here (SDK client initialization, context propagation, error handling with typed errors) should be the organization-wide standard, enforced by code review and shared library adoption.

The most impactful thing a staff engineer can do with this reference: turn it into an internal SDK wrapper that encodes the organization's standards (timeouts, retry policies, instrumentation, cost attribution tags) and makes these patterns the default for every team. When a team imports `internal/cloud/s3` and gets a pre-configured S3 client with standard observability and cost tagging, the quick reference becomes unnecessary because the standards are encoded in the library. That is the L6/L7 contribution: moving standards from documentation that teams may not read to infrastructure that teams cannot avoid using correctly.
