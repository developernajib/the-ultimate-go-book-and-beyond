## 100.12 Mid-Chapter Synthesis: Cloud Providers Comparison

### Cloud Provider Comparison

Both AWS and GCP provide first-class Go SDK support, but their service naming, authentication flows, and API ergonomics differ in ways that matter when you are building portable infrastructure code. AWS organizes its SDK into per-service packages (`s3`, `dynamodb`, `sqs`) under `aws-sdk-go-v2`, using a config-driven client factory pattern, while GCP's `cloud.google.com/go` library uses idiomatic Go interfaces and Google's Application Default Credentials for authentication. Understanding which managed services map to each other reduces migration cost and enables shared abstractions when targeting both clouds.

```
┌──────────────────────────────────────────────────────────────────┐
│                AWS vs GCP FOR GO APPLICATIONS                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SERVICE             AWS              GCP                        │
│  ─────────────────────────────────────────────────────────────   │
│  Object Storage      S3               Cloud Storage              │
│  NoSQL DB            DynamoDB         Firestore/Bigtable         │
│  Messaging           SQS/SNS          Pub/Sub                    │
│  Functions           Lambda           Cloud Functions            │
│  Containers          ECS/EKS          Cloud Run/GKE              │
│  Managed K8s         EKS              GKE                        │
│                                                                  │
│  GO SDK QUALITY:                                                 │
│  AWS: aws-sdk-go-v2 (mature, modular)                            │
│  GCP: cloud.google.com/go (idiomatic, well-documented)           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Takeaways

1. **Use SDK v2 for AWS** - Better performance and modularity
2. **Initialize clients in Lambda init()** - Reuse connections
3. **Use context everywhere** - Enables cancellation and timeouts
4. **Handle pagination** - Use paginators for listing operations
5. **Batch operations** - Reduce API calls when possible

### Best Practices Checklist

- [ ] Use environment-based configuration
- [ ] Initialize cloud clients once (singleton pattern)
- [ ] Handle rate limiting and retries
- [ ] Use presigned URLs for direct uploads
- [ ] Implement proper error handling
- [ ] Log cloud operations for debugging
- [ ] Use IAM roles over static credentials
- [ ] Enable CloudTrail/Audit Logs

---

### Junior → FAANG: Building Cloud Provider Competence Systematically

The cloud provider landscape is broad, and building competence requires a deliberate strategy rather than trying to learn everything simultaneously. The most productive path: become deeply competent in one provider (AWS if you are in the US market, GCP if you are at a Google-related company, Azure for Microsoft-oriented enterprise environments), then build familiarity with the others. Deep competence in one provider makes cross-provider knowledge faster to acquire because the concepts transfer even when the specific services differ.

The certification path (AWS Solutions Architect, GCP Professional Cloud Architect) is a valuable signal for employers and provides structured curriculum, but it should supplement hands-on experience, not replace it. Building real systems with real billing is more durable learning than certification exam preparation.

### Senior @ FAANG: Cloud Platform Ownership and Financial Accountability

At L6/L7, cloud platform ownership includes financial accountability. The AWS/GCP bill is an engineering concern, not only a finance concern. Staff engineers who own cloud infrastructure are responsible for understanding the cost model of each service they use, identifying optimization opportunities, and making the trade-offs between cost and performance/reliability explicit.

The cloud cost management practices at this level: cost allocation tagging enforced at the cloud account level, per-service cost tracking using tags and billing exports to BigQuery or Cost Explorer, quarterly cost optimization reviews that compare committed capacity against actual usage and identify rightsizing opportunities, and an annual architecture review that evaluates whether the current service selection is still the most cost-effective choice given current usage patterns and the expanded managed service catalog. These practices, consistently applied, keep cloud costs at 15-25% of revenue for typical SaaS companies rather than the 35-50% range that undisciplined cloud usage produces.
