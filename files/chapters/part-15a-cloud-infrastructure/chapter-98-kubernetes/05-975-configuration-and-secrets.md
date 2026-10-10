## 98.5 Configuration and Secrets

### ConfigMap

A ConfigMap stores non-sensitive configuration data as key-value pairs that can be injected into pods as environment variables or mounted as files. Separating configuration from the container image means the same image can be promoted through dev, staging, and production environments simply by swapping the ConfigMap, without rebuilding or republishing.

```yaml
# configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: myapp-config
data:
  LOG_LEVEL: "info"
  CACHE_TTL: "300"
  config.yaml: |
    server:
      port: 8080
      timeout: 30s
    database:
      maxConnections: 10
      idleTimeout: 5m
```

### Secret

Kubernetes Secrets hold sensitive values such as passwords, API keys, and connection strings. Unlike ConfigMaps, Secrets are base64-encoded in etcd and can be encrypted at rest when the cluster is configured with an encryption provider. Using `stringData` instead of `data` lets you supply plaintext values directly in the manifest, Kubernetes handles the encoding automatically before persisting.

```yaml
# secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: myapp-secrets
type: Opaque
stringData:
  DATABASE_URL: "postgres://user:pass@host:5432/db"
  API_KEY: "secret-key-here"
```

### Using in Deployment

The `envFrom` field bulk-injects every key from a ConfigMap or Secret as a separate environment variable, eliminating the need to enumerate each value individually. The same ConfigMap can also be projected as a file by referencing it in the `volumes` section and mounting it into the container, which is useful for configuration files that the application reads from disk rather than from the environment.

```yaml
spec:
  containers:
  - name: myapp
    envFrom:
    - configMapRef:
        name: myapp-config
    - secretRef:
        name: myapp-secrets
    volumeMounts:
    - name: config-volume
      mountPath: /etc/config
  volumes:
  - name: config-volume
    configMap:
      name: myapp-config
      items:
      - key: config.yaml
        path: config.yaml
```

### Junior → FAANG: Kubernetes Configuration Patterns That Scale

The ConfigMap and Secret distinction is important: ConfigMaps are for non-sensitive configuration (feature flags, endpoint URLs, log levels), Secrets are for sensitive data (API keys, database passwords, TLS certificates). But Kubernetes Secrets are only base64-encoded by default, not encrypted. This is a critical distinction: a Secret is not secret unless the cluster has encryption-at-rest enabled and RBAC prevents unauthorized reads.

The volume mount pattern for Secrets is generally preferred over environment variables in production. When a Secret is mounted as a volume file, it can be updated without restarting the pod (if the application watches the file). When a Secret is injected as an environment variable, the pod must be restarted to pick up the new value. For secrets that rotate frequently (short-lived credentials, API keys), the file mount pattern is significantly more operational.

First-job habit: always label and annotate resources meaningfully. Labels are searchable; annotations are for metadata. A consistent labeling scheme (`app`, `version`, `team`, `environment`) makes resource management, cost allocation, and debugging much easier at scale.

### Senior @ FAANG: Configuration Architecture and Secret Sprawl at Cluster Scale

At staff level, configuration management in Kubernetes is a governance problem. A cluster with 300 namespaces and thousands of ConfigMaps and Secrets, each created individually by different teams using different naming conventions and different value formats, is unmaintainable. The architectural solution is a configuration management layer that sits above the raw Kubernetes API.

The mature patterns are: External Secrets Operator (ESO) for syncing secrets from a central secrets store (Vault, AWS Secrets Manager) into Kubernetes Secrets automatically, with automatic rotation. Kustomize or Helm for templating the configuration files so that per-environment differences are expressed as overlays or values files rather than duplicated manifests. ConfigMap hot-reload via a watcher pattern in the application (using the Kubernetes downward API or inotify on mounted files) so that configuration changes do not require pod restarts.

The encryption-at-rest decision for Secrets belongs in the cluster configuration and needs to be made before sensitive data is stored. Options are: using the Kubernetes built-in encryption provider with a locally stored key (single point of failure for the key), using a KMS-backed encryption provider (AWS KMS, GCP KMS) so the encryption key is managed by the cloud provider's HSM infrastructure, or using an external secrets store entirely and keeping nothing sensitive in etcd. Each option has different operational complexity and security properties that need to be evaluated against the organization's threat model.

---
