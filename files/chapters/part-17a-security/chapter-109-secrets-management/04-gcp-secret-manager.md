## 109.4 GCP Secret Manager

Google Cloud Secret Manager provides similar functionality for GCP environments.

### GCP Secret Manager Client

GCP Secret Manager client authenticates using Application Default Credentials, automatically using Workload Identity when the Go service runs in GKE, so no service account key file needs to be distributed or rotated. The `AccessSecretVersion` call retrieves a specific numbered version or `latest`, and the raw bytes returned contain the secret payload ready for use. Accessing `latest` by default means the application always picks up newly activated versions after a rotation without code changes, but version pinning can be used in staging environments to avoid accidental early adoption of a new credential.

```go
// pkg/secrets/gcp.go
package secrets

import (
    "context"
    "fmt"

    secretmanager "cloud.google.com/go/secretmanager/apiv1"
    "cloud.google.com/go/secretmanager/apiv1/secretmanagerpb"
)

// GCPSecretManager wraps GCP Secret Manager client
type GCPSecretManager struct {
    client *secretmanager.Client
    projectID string
}

// NewGCPSecretManager creates a new GCP Secret Manager client
func NewGCPSecretManager(ctx context.Context, projectID string) (*GCPSecretManager, error) {
    client, err := secretmanager.NewClient(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to create secret manager client: %w", err)
    }

    return &GCPSecretManager{
        client:    client,
        projectID: projectID,
    }, nil
}

// Close closes the client
func (g *GCPSecretManager) Close() error {
    return g.client.Close()
}

// GetSecret retrieves the latest version of a secret
func (g *GCPSecretManager) GetSecret(ctx context.Context, secretID string) (string, error) {
    name := fmt.Sprintf("projects/%s/secrets/%s/versions/latest", g.projectID, secretID)

    req := &secretmanagerpb.AccessSecretVersionRequest{
        Name: name,
    }

    result, err := g.client.AccessSecretVersion(ctx, req)
    if err != nil {
        return "", fmt.Errorf("failed to access secret %s: %w", secretID, err)
    }

    return string(result.Payload.Data), nil
}

// CreateSecret creates a new secret
func (g *GCPSecretManager) CreateSecret(ctx context.Context, secretID string) error {
    req := &secretmanagerpb.CreateSecretRequest{
        Parent:   fmt.Sprintf("projects/%s", g.projectID),
        SecretId: secretID,
        Secret: &secretmanagerpb.Secret{
            Replication: &secretmanagerpb.Replication{
                Replication: &secretmanagerpb.Replication_Automatic_{
                    Automatic: &secretmanagerpb.Replication_Automatic{},
                },
            },
        },
    }

    _, err := g.client.CreateSecret(ctx, req)
    if err != nil {
        return fmt.Errorf("failed to create secret %s: %w", secretID, err)
    }

    return nil
}

// AddSecretVersion adds a new version to an existing secret
func (g *GCPSecretManager) AddSecretVersion(ctx context.Context, secretID, payload string) error {
    req := &secretmanagerpb.AddSecretVersionRequest{
        Parent: fmt.Sprintf("projects/%s/secrets/%s", g.projectID, secretID),
        Payload: &secretmanagerpb.SecretPayload{
            Data: []byte(payload),
        },
    }

    _, err := g.client.AddSecretVersion(ctx, req)
    if err != nil {
        return fmt.Errorf("failed to add version to secret %s: %w", secretID, err)
    }

    return nil
}
```

### Junior → FAANG: GCP Secret Manager and Workload Identity

GCP Secret Manager follows the same pattern as AWS Secrets Manager but uses GCP-native authentication. The key concept is that services running on GCP use Workload Identity to authenticate without static credentials.

**Gap to close:** Understand GCP Workload Identity Federation. In GKE (Google Kubernetes Engine), a Kubernetes service account is linked to a GCP service account. Pods running with that Kubernetes service account automatically present a GCP identity. The GCP service account has IAM permissions to access specific secrets in Secret Manager. No static credentials are needed anywhere in this chain.

**Interview framing:** When asked "how does a Go service on GKE access Secret Manager without credentials?", describe: GKE Workload Identity links the Kubernetes service account to a GCP service account. The Go SDK automatically uses the workload identity token. The GCP service account has `roles/secretmanager.secretAccessor` on specific secret resources. No credential is stored in the pod or the cluster.

### Senior @ FAANG: Multi-Cloud Secrets Management Strategy

At senior level, organizations often use multiple cloud providers, and secrets management spans all of them. The architectural challenge is providing a consistent developer experience while using cloud-native mechanisms where appropriate.

**Abstraction layer design:** Rather than having service code directly use the AWS SDK for Secrets Manager, the GCP client library for Secret Manager, or the Vault client, build a thin abstraction layer that presents a uniform interface: `GetSecret(ctx, name) ([]byte, error)`. The implementation selects the appropriate backend based on the runtime environment. This allows services to be cloud-portable and simplifies testing (the abstraction can return values from a static map in tests).

**Cross-cloud secret synchronization:** Some organizations need the same secret in multiple cloud providers (a shared API key used by services on both AWS and GCP). Rather than storing it in both places independently (creating a synchronization problem), use a central secrets manager (Vault) as the source of truth and push to cloud-specific managers as needed. Or use the workload identity approach to eliminate the shared secret entirely by using per-cloud credentials for the same downstream service. Document the pattern chosen in an ADR.

---