## 111.5 Kubernetes Service Accounts

Kubernetes provides built-in service accounts with automatic token projection.

### Using Kubernetes Service Account Tokens

Kubernetes projected service account tokens are short-lived (default 1-hour TTL) and audience-scoped, unlike the legacy long-lived tokens stored as Secrets. The kubelet rotates them automatically and they are bound to the specific pod's lifetime. The Go service reads the token from the projected volume path and includes it in the `Authorization: Bearer` header when calling the Kubernetes API server or another service that validates pod identity. Using `TokenRequest` with a specific audience restricts the token to only be valid against that audience's validator, preventing a compromised service from reusing tokens across multiple internal APIs.

```go
package main

import (
    "context"
    "fmt"
    "os"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

// K8sServiceAccountAuth authenticates using Kubernetes service account
type K8sServiceAccountAuth struct {
    tokenPath string
    namespace string
}

// NewK8sServiceAccountAuth creates authenticator for in-cluster use
func NewK8sServiceAccountAuth() *K8sServiceAccountAuth {
    return &K8sServiceAccountAuth{
        tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        namespace: os.Getenv("POD_NAMESPACE"),
    }
}

// GetToken reads the current service account token
func (k *K8sServiceAccountAuth) GetToken() (string, error) {
    token, err := os.ReadFile(k.tokenPath)
    if err != nil {
        return "", fmt.Errorf("reading service account token: %w", err)
    }
    return string(token), nil
}

// CreateInClusterClient creates a Kubernetes client using service account
func (k *K8sServiceAccountAuth) CreateInClusterClient() (*kubernetes.Clientset, error) {
    config, err := rest.InClusterConfig()
    if err != nil {
        return nil, fmt.Errorf("creating in-cluster config: %w", err)
    }

    clientset, err := kubernetes.NewForConfig(config)
    if err != nil {
        return nil, fmt.Errorf("creating kubernetes client: %w", err)
    }

    return clientset, nil
}

// VerifyServiceAccount ensures the service account has expected permissions
func (k *K8sServiceAccountAuth) VerifyServiceAccount(ctx context.Context) error {
    clientset, err := k.CreateInClusterClient()
    if err != nil {
        return err
    }

    // Test access by listing pods in own namespace
    _, err = clientset.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{Limit: 1})
    if err != nil {
        return fmt.Errorf("service account lacks permissions: %w", err)
    }

    return nil
}

func main() {
    auth := NewK8sServiceAccountAuth()
    ctx := context.Background()
    if err := auth.VerifyServiceAccount(ctx); err != nil {
        fmt.Printf("Verification error (expected outside cluster): %v\n", err)
    }
}
```

### Junior → FAANG: Kubernetes Service Accounts as Workload Identity

Kubernetes service accounts are the most widely used workload identity mechanism for cloud-native services. Understanding them deeply is required for any backend role at a company that uses Kubernetes.

**Gap to close:** Know the difference between the default service account (automounted in every pod unless disabled) and a dedicated service account per service (best practice). The default service account has no RBAC permissions, but its token can be used to authenticate to any service that trusts the Kubernetes API server as an OIDC provider. Create dedicated service accounts for each service with only the RBAC permissions that service needs.

**Token projection:** With Kubernetes projected service account tokens (`serviceAccountToken` volume), tokens are: audience-specific (the token is only valid for a specific audience, preventing token reuse across services), time-limited (the kubelet automatically rotates them), and bound to the pod (the token is invalidated when the pod terminates). These properties make projected tokens much safer than the legacy service account tokens that were long-lived and not audience-specific.

**Interview framing:** When asked "how does a Kubernetes pod authenticate to an external service?", describe projected service account tokens: the pod mounts a projected token with the external service as the audience, the pod presents the token to the external service, and the external service verifies it against the Kubernetes OIDC endpoint. For AWS, this is IRSA (IAM Roles for Service Accounts). For GCP, this is Workload Identity. For Vault, this is the Kubernetes auth method. All three use the same underlying mechanism.

### Senior @ FAANG: Kubernetes Service Account Governance

At senior level, Kubernetes service account governance prevents privilege accumulation and ensures least-privilege workload identity across the entire cluster.

**Service account inventory:** Maintain an inventory of all Kubernetes service accounts across all namespaces, their associated RBAC roles, and the services that use them. Any service account with `cluster-admin` or broad `*` permissions is a finding that requires remediation. Service accounts should have exactly the permissions they need: nothing more. Review the inventory quarterly.

**RBAC minimization policy:** Define a policy that service accounts may not have cluster-scope permissions unless explicitly approved. Namespace-scope permissions are preferred. `get`, `list`, and `watch` permissions are preferred over `create`, `update`, `delete`, and `patch` for read-only services. Enforce this policy with OPA or Kyverno admission policies that reject service account bindings that exceed the allowed permission scope.

**Cross-cluster identity:** In organizations with multiple Kubernetes clusters (dev, staging, production, multiple regions), service account tokens are cluster-scoped: a token from the dev cluster is not valid in the production cluster. Use SPIFFE/SPIRE federation or cloud-provider workload identity to establish cross-cluster identity without static credentials. Document the cross-cluster authentication mechanism for each pair of clusters that need to communicate.

---
