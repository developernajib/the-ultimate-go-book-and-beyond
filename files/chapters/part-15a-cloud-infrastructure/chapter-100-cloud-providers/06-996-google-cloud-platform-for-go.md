## 100.6 Google Cloud Platform for Go

### GCP Configuration

GCP client libraries for Go use Application Default Credentials (ADC), which automatically resolve credentials from the `GOOGLE_APPLICATION_CREDENTIALS` environment variable, the metadata server when running on GCP infrastructure (GCE, GKE, Cloud Run), or `gcloud auth application-default login` for local development. Each client is instantiated per service (storage, pubsub, bigquery) and accepts functional options via `google.golang.org/api/option`, allowing you to override the credential source, endpoint, or HTTP transport. Clients hold connection pools internally and should be created once and shared across the application rather than instantiated per request.

```go
package main

import (
    "context"
    "fmt"
    "log"

    "cloud.google.com/go/storage"
    "google.golang.org/api/option"
)

func main() {
    ctx := context.Background()

    // Using default credentials (GOOGLE_APPLICATION_CREDENTIALS)
    client, err := storage.NewClient(ctx)
    if err != nil {
        log.Fatalf("failed to create client: %v", err)
    }
    defer client.Close()

    // Or with explicit credentials
    clientWithCreds, err := storage.NewClient(ctx,
        option.WithCredentialsFile("/path/to/service-account.json"),
    )
    if err != nil {
        log.Fatalf("failed to create client: %v", err)
    }
    defer clientWithCreds.Close()

    // List buckets
    it := client.Buckets(ctx, "my-project-id")
    for {
        bucketAttrs, err := it.Next()
        if err != nil {
            break
        }
        fmt.Printf("Bucket: %s\n", bucketAttrs.Name)
    }
}
```

---

### Junior → FAANG: GCP for Go Fundamentals and Application Default Credentials

GCP's client library design for Go is consistent and idiomatic. The Application Default Credentials (ADC) model is the GCP equivalent of AWS's credential chain: the library searches for credentials in a defined order (environment variable `GOOGLE_APPLICATION_CREDENTIALS`, well-known file, GCP metadata server). In production on GCP infrastructure (GKE, Cloud Run, Cloud Functions), the metadata server provides credentials automatically via the attached service account.

The Workload Identity feature (for GKE) maps Kubernetes service accounts to GCP service accounts without requiring a service account key file. This is the correct production pattern: no long-lived credentials, no key rotation, audit logs of service account usage in Cloud Audit Logs. Using a service account key file in production is acceptable only if Workload Identity is not available, and it requires a rotation process.

First-job habit: always use the narrowest possible IAM role for each service account. The Principle of Least Privilege applies equally to GCP IAM. A service that only reads from Cloud Storage should have the `roles/storage.objectViewer` role on the specific bucket, not `roles/storage.admin` on all buckets.

### Senior @ FAANG: GCP Architecture and Organizational IAM Design

At staff level, GCP IAM is a hierarchy: Organization, Folder, Project, Resource. Each level can have IAM bindings, and lower levels inherit from higher levels. The organizational IAM design determines which identities have access to which resources, and getting it wrong either creates excessive blast radius (too-broad permissions) or operational friction (insufficient permissions for legitimate work).

The recommended organizational design for a medium-to-large engineering team: separate GCP projects per environment (production, staging, development) and per team (or service domain), with organization-level policies that enforce mandatory controls (required labels, restricted resource types, data residency requirements), and Folder-level bindings for cross-team shared services. Each project has a dedicated service account for automated access, with permissions scoped to exactly what the automation needs.

The GCP-specific architectural decisions that require staff judgment: VPC Shared VPC versus standalone VPC per project (Shared VPC enables centralized network management, standalone gives teams more autonomy), Cloud IAM conditions for time-limited or attribute-based access (useful for break-glass emergency access), and Organization Policy constraints that prevent specific resource configurations (like disabling public IP addresses for all VMs except explicitly approved ones). Each of these is a governance mechanism that reduces operational risk but requires organizational agreement to implement and maintain.
