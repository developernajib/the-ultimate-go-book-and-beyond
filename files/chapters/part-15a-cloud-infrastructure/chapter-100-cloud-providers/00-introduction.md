# Chapter 100: Cloud Providers - AWS, GCP, and Azure for Go

> *"The cloud is not someone else's computer. It's a programmable infrastructure with an API - and Go is one of the best languages ever built for consuming APIs."*

The major cloud providers - Amazon Web Services, Google Cloud Platform, and Microsoft Azure - all offer first-class Go SDKs that give you programmatic access to hundreds of managed services. These SDKs are not afterthoughts. AWS SDK v2 for Go was rewritten from scratch to be idiomatic, context-aware, and modular. GCP's client libraries follow the same conventions as the Kubernetes client. Azure SDK for Go embraces interfaces for testability. Using these SDKs correctly means understanding not just the API calls themselves, but the patterns around them: IAM roles and service accounts for credential management, retry and backoff strategies for resilience, middleware hooks for observability, and interface-based mocking for unit testing cloud-dependent code without real API calls.

Each cloud provider offers a different deployment surface for Go applications. On AWS, you can run Go as Lambda functions (with the custom runtime or `provided.al2023`), as ECS tasks in Fargate (serverless containers), or as Kubernetes workloads on EKS. On GCP, Cloud Run provides instant, scale-to-zero container hosting with no cluster management, while GKE Autopilot handles the Kubernetes control plane. On Azure, Container Apps and AKS offer similar patterns. The choice between these compute surfaces is a function of traffic patterns, latency requirements, cost structure, and operational complexity - and Go's fast startup time and low memory footprint make it competitive on every surface, including the coldest cold-starts in serverless environments.

Beyond compute, cloud providers offer managed services that replace entire engineering teams: S3/GCS/Azure Blob for object storage, DynamoDB/Firestore/Cosmos for NoSQL persistence, SQS/Pub/Sub/Service Bus for reliable messaging, RDS/Cloud SQL/Azure SQL for relational databases, and ElastiCache/Memorystore/Azure Cache for distributed caching. Integrating these services correctly means understanding connection pooling, SDK pagination patterns, eventual consistency tradeoffs, and cost-optimization techniques like S3 intelligent tiering and DynamoDB on-demand capacity. This chapter gives you the patterns and practical code to integrate Go applications with all three major cloud providers while maintaining multi-cloud portability where it matters.

**What you'll learn in this chapter:**

- How to configure AWS SDK v2 for Go with proper credential chains, regional clients, and middleware for logging and retries
- How to deploy Go applications to AWS Lambda using the `aws-lambda-go` runtime, including structured logging, X-Ray tracing, and cold-start optimization
- How to integrate with AWS managed services - S3 for object storage, DynamoDB for NoSQL, SQS/SNS for messaging - using idiomatic Go SDK patterns
- How to use GCP client libraries for Go to integrate with Cloud Storage, Pub/Sub, Firestore, and BigQuery, including workload identity for credential-free authentication
- How to deploy Go services to GCP Cloud Run with automatic scaling, custom domains, and VPC connectivity to private services
- How to use the Azure SDK for Go with managed identity authentication, integrating with Blob Storage, Service Bus, and Azure SQL
- How to design multi-cloud abstractions using Go interfaces that allow swapping cloud provider implementations without changing business logic
- How to implement cost optimization patterns - request batching, connection reuse, caching hot paths, and right-sizing compute - that reduce cloud spend at scale

**Why this matters at scale:**

Capital One migrated its core banking workloads to AWS, using Go Lambda functions to process millions of financial transactions per day with sub-100ms p99 latency. Spotify runs its entire data pipeline on GCP, with Go services consuming Pub/Sub streams that carry billions of listening events daily - the Go SDK's goroutine model maps naturally onto Pub/Sub's concurrent message delivery model. Twitter (now X) historically ran its infrastructure primarily in self-managed data centers, with Go powering key internal services. The platform has since explored cloud migration to reduce operational overhead. Monzo, the UK neobank, built its entire core banking infrastructure as Go microservices on AWS, processing over £20 billion in transactions annually with near-zero downtime.

**Prerequisites:** Chapters 96-98 (Docker, Kubernetes, CI/CD), an account with at least one cloud provider, and familiarity with Go interfaces from Part 2.

---

### Junior → FAANG: Cloud Providers as Managed Infrastructure APIs

The most useful mental model for cloud providers: they are managed infrastructure available as APIs. S3 is a key-value store API where the keys are object paths and the values are blobs. DynamoDB is a managed NoSQL database API. SQS is a managed queue API. Understanding each service as an API with specific consistency guarantees, cost models, and failure modes is more durable than memorizing their features.

The Go AWS SDK v2 and GCP Go client libraries are well-designed and follow Go idioms (context propagation, error handling, option functions). Getting comfortable with them requires reading the API documentation, not just copying examples. Understanding what each API call does, what its error modes are, and how to handle them correctly is the foundation of cloud-native Go programming.

First-job habit: always use IAM roles and OIDC-based credential federation for cloud access, never hardcoded access keys. Access keys that are checked in by accident are a well-documented incident pattern with severe consequences.

### Senior @ FAANG: Cloud Provider Strategy and Multi-Cloud Architecture

At staff level, cloud provider selection is an architectural decision that needs to be documented in an ADR and revisited periodically. The decision criteria include: which managed services match the technical requirements, what the organizational relationships and pricing commitments look like, what the compliance certifications required are (FedRAMP, PCI DSS, HIPAA), and what the exit strategy looks like if the provider is no longer the right choice in 5 years.

Multi-cloud architecture is a frequent topic in staff-level interviews and discussions. The honest answer is that genuine multi-cloud (running the same service across multiple providers simultaneously for redundancy) is extremely complex and rarely worth the operational cost for most organizations. The pragmatic senior approach is cloud-portable application design (using managed services through abstraction layers, avoiding provider-specific features that have no equivalent elsewhere) combined with a clear decision to run primarily on one cloud while maintaining the ability to migrate if required.

The L6/L7 contribution to cloud provider strategy is designing the abstraction layers that allow the application code to remain cloud-agnostic while using provider-specific managed services efficiently. This requires Go interfaces that model the semantic behavior (not the API signatures) of each service category, and careful evaluation of which provider-specific optimizations are worth taking a dependency on.
