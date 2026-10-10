## 111.6 Cloud Provider Workload Identity

### AWS IRSA (IAM Roles for Service Accounts)

AWS IRSA works by projecting a service account token signed by the cluster's OIDC issuer into the pod, then configuring IAM to trust that issuer and map the service account's `sub` claim to an IAM role ARN. The AWS SDK v2 automatically detects the projected token path from the `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN` environment variables that EKS sets on pods with annotated service accounts, exchanging them for temporary STS credentials without any Go-side credential management code. This eliminates the need for AWS access key secrets entirely. The pod's IAM permissions are determined by which IAM role the service account annotation references, which can be updated without redeploying the pod.

```go
package main

import (
    "context"
    "fmt"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

// AWSWorkloadIdentity uses IRSA for AWS authentication
type AWSWorkloadIdentity struct {
    roleARN string
}

// NewAWSWorkloadIdentity creates workload identity client
func NewAWSWorkloadIdentity(roleARN string) *AWSWorkloadIdentity {
    return &AWSWorkloadIdentity{roleARN: roleARN}
}

// GetAWSConfig returns AWS config using pod service account
func (w *AWSWorkloadIdentity) GetAWSConfig(ctx context.Context) (aws.Config, error) {
    // AWS SDK automatically uses IRSA when running in EKS
    // It reads the web identity token from the mounted volume
    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        return aws.Config{}, fmt.Errorf("loading AWS config: %w", err)
    }

    return cfg, nil
}

// Example: Access S3 using workload identity
func (w *AWSWorkloadIdentity) ListBuckets(ctx context.Context) error {
    cfg, err := w.GetAWSConfig(ctx)
    if err != nil {
        return err
    }

    client := s3.NewFromConfig(cfg)
    result, err := client.ListBuckets(ctx, &s3.ListBucketsInput{})
    if err != nil {
        return fmt.Errorf("listing buckets: %w", err)
    }

    for _, bucket := range result.Buckets {
        fmt.Printf("Bucket: %s\n", *bucket.Name)
    }

    return nil
}

func main() {
    identity := NewAWSWorkloadIdentity("arn:aws:iam::123456789012:role/my-irsa-role")
    ctx := context.Background()
    if err := identity.ListBuckets(ctx); err != nil {
        fmt.Printf("ListBuckets error (expected without AWS credentials): %v\n", err)
    }
}
```

### Junior → FAANG: Cloud Workload Identity as the No-Credential Pattern

Cloud provider workload identity (AWS IRSA, GCP Workload Identity, Azure Managed Identity) is the correct pattern for services that need to access cloud APIs. The core property is that no credential is stored anywhere: the cloud platform provides authentication automatically.

**Gap to close:** Know how AWS IRSA works at a mechanical level: the Kubernetes service account has an annotation (`eks.amazonaws.com/role-arn`) linking it to an IAM role. EKS projects a service account token into the pod with `sts.amazonaws.com` as the audience. The AWS SDK exchanges this token for temporary IAM credentials via the STS `AssumeRoleWithWebIdentity` API. The IAM role's trust policy verifies the token came from your EKS cluster's OIDC provider. No static AWS credentials exist anywhere in this chain.

**Common mistake:** Using `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables in a Kubernetes deployment. These static credentials are long-lived, cannot be scoped to a specific cluster or namespace, and are a severe security risk. If you see these in a Kubernetes manifest, it is a finding that requires immediate remediation.

**Interview framing:** When asked "how does your Go service on EKS authenticate to AWS APIs?", describe IRSA: annotate the service account with the IAM role ARN, the AWS SDK automatically uses the projected token, no credentials are stored in the pod or the environment. This is the correct answer at any FAANG-adjacent company.

### Senior @ FAANG: Cloud Workload Identity Governance

At senior level, cloud workload identity governance prevents over-permissioned IAM roles from becoming a lateral movement vector in the event of a pod compromise.

**IAM role scope minimization:** Each service's IAM role should grant exactly the permissions the service needs. Avoid broad roles (`AmazonS3FullAccess`) in favor of custom policies that specify exact resources and actions. Use resource-level conditions where available: "allow s3:GetObject on `arn:aws:s3:::my-bucket/service-specific-prefix/*`" is more secure than "allow s3:GetObject on `*`." Review IAM roles quarterly and remove unused permissions.

**IAM role audit:** AWS IAM Access Analyzer identifies IAM roles with permissions that are never used (based on CloudTrail access data). Use this to identify and remove unused permissions from each service's IAM role. This moves the principle of least privilege from an aspiration to a measurably maintained property.

**Cross-account workload identity:** When services in one AWS account need to access resources in another (a common pattern in AWS Organizations with account-per-environment or account-per-team), use cross-account IAM role assumption rather than creating IAM users or access keys in the target account. The service's IAM role in the source account assumes a role in the target account. The trust relationship is explicit, auditable, and revocable. Document all cross-account trust relationships in your IAM governance register.

---
