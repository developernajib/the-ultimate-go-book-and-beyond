## 109.5 Kubernetes Secrets Handling

Kubernetes Secrets should be used carefully: they're base64-encoded, not encrypted by default.

### Mounting Secrets as Files

Mounting Kubernetes Secrets as files rather than environment variables prevents the credentials from appearing in process listings (`/proc/<pid>/environ`) and in container runtime logs that record the full environment at startup. The secret volume mount causes Kubernetes to write the secret value to a tmpfs path that exists only in memory on the node, and the kubelet automatically updates the file content when the Secret is rotated, enabling the Go service to re-read the file periodically without restarting. Enabling encryption at rest (`EncryptionConfiguration`) in the kube-apiserver ensures the Secret data is not stored in plaintext in etcd.

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  template:
    spec:
      containers:
      - name: app
        image: myapp:latest
        volumeMounts:
        - name: db-credentials
          mountPath: /etc/secrets
          readOnly: true
      volumes:
      - name: db-credentials
        secret:
          secretName: db-credentials
```

### Reading Mounted Secrets in Go

The helpers below read a mounted secret file or a directory of per-key files into a typed config struct. Because the kubelet updates mounted files when the Secret changes, calling these helpers from a periodic re-read loop supports zero-downtime credential rotation: the kubelet updates the mounted file and the application picks up the new credentials on the next read without a pod restart. Using `os.ReadFile` rather than keeping a file handle open ensures the reader always sees the current symlink target that Kubernetes atomically swaps when updating the Secret.

```go
// pkg/k8s/secrets.go
package k8s

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
)

// ReadSecretFile reads a secret mounted as a file
func ReadSecretFile(secretPath string) (string, error) {
    data, err := os.ReadFile(secretPath)
    if err != nil {
        return "", fmt.Errorf("failed to read secret file %s: %w", secretPath, err)
    }

    return string(data), nil
}

// ReadSecretJSON reads and unmarshals a JSON secret
func ReadSecretJSON(secretPath string, v any) error {
    data, err := ReadSecretFile(secretPath)
    if err != nil {
        return err
    }

    if err := json.Unmarshal([]byte(data), v); err != nil {
        return fmt.Errorf("failed to unmarshal secret: %w", err)
    }

    return nil
}

// DBConfig holds database connection settings read from mounted secret files
type DBConfig struct {
    Host     string
    Username string
    Password string
}

// LoadDBConfigFromK8s loads database config from mounted Kubernetes secret
func LoadDBConfigFromK8s(secretDir string) (*DBConfig, error) {
    var config DBConfig

    // Read individual secret files
    username, err := ReadSecretFile(filepath.Join(secretDir, "username"))
    if err != nil {
        return nil, err
    }
    config.Username = username

    password, err := ReadSecretFile(filepath.Join(secretDir, "password"))
    if err != nil {
        return nil, err
    }
    config.Password = password

    host, err := ReadSecretFile(filepath.Join(secretDir, "host"))
    if err != nil {
        return nil, err
    }
    config.Host = host

    return &config, nil
}
```

### Using External Secrets Operator

For production, use External Secrets Operator to sync from Vault, AWS, or GCP:

```yaml
# external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: db-credentials
    creationPolicy: Owner
  data:
  - secretKey: username
    remoteRef:
      key: database/prod
      property: username
  - secretKey: password
    remoteRef:
      key: database/prod
      property: password
```

### Junior → FAANG: Why Kubernetes Secrets Are Not Enough

Kubernetes Secrets are base64-encoded by default, not encrypted. An attacker with read access to etcd (the Kubernetes control plane data store) can read all secrets. This is a well-known gap that juniors must understand before using Kubernetes Secrets for sensitive values.

**Gap to close:** Know the three ways to improve Kubernetes secrets security: (1) encryption at rest in etcd (configured in the kube-apiserver, ideally backed by a KMS provider for the encryption key), (2) external secrets operators (External Secrets Operator, Secrets Store CSI Driver) that fetch secrets from an external secrets manager and inject them into pods without storing them in etcd, (3) Vault Agent Injector as a sidecar that fetches and refreshes secrets from Vault and writes them to a shared volume. Each approach has different operational complexity and security guarantees.

**First-job habit:** Never store sensitive secrets (database passwords, API keys, TLS private keys) in a Kubernetes Secret without verifying that etcd encryption at rest is enabled. Check this on your first week at a new company: on self-managed clusters, confirm the kube-apiserver runs with `--encryption-provider-config`. On managed clusters (EKS, GKE, AKS), confirm with the platform team that application-layer secrets encryption is enabled.

### Senior @ FAANG: Kubernetes Secrets Architecture at Scale

At senior level, Kubernetes secrets management is a platform concern that spans all clusters across all environments. Inconsistent secrets management practices across clusters create compliance gaps and complicate security audits.

**Cluster-wide secrets policy:** Define a policy for every cluster: which secrets managers are approved (Vault via the Vault Agent Injector, AWS Secrets Manager via External Secrets Operator, native Kubernetes Secrets only for non-sensitive configuration), which sensitive secret types must use external secrets managers (database credentials, TLS private keys, API keys for third-party services), and how compliance is verified (Admission Controller policies that reject Kubernetes Secret creation for sensitive key patterns).

**Secrets Store CSI Driver vs External Secrets Operator:** These are the two dominant patterns for injecting external secrets into Kubernetes pods. The Secrets Store CSI Driver mounts secrets as a volume (the secret is never stored in etcd). External Secrets Operator creates Kubernetes Secret objects from external sources (the secret is stored in etcd, so etcd encryption is required). Each has different operational characteristics. Document the choice in an ADR, noting the etcd storage implication of External Secrets Operator.

**Secrets access audit in Kubernetes:** Kubernetes API audit logs capture every access to a Secret object. Enable audit logging and route it to your SIEM. Create detection rules for anomalous secret access (a pod accessing a Secret it does not normally access, bulk secret listing by a compromised service account). This turns the Kubernetes API server's audit log into a detection mechanism for secrets compromise in your cluster.

---