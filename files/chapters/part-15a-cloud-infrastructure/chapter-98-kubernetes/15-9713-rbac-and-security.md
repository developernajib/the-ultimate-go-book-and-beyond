## 98.15 RBAC and Security

### Service Account with Minimal Permissions

By default, Kubernetes mounts the `default` service account token in every pod, which often has broad cluster permissions inherited from overly permissive cluster roles. The manifest below creates a dedicated `ServiceAccount`, a namespace-scoped `Role` that grants only the exact verbs needed (read specific ConfigMaps and Secrets, manage lease objects for leader election), and a `RoleBinding` wiring them together, so a compromised pod cannot enumerate other secrets or escalate privileges within the cluster.

```yaml
# rbac/service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: go-service
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: go-service-role
  namespace: production
rules:
  # Read ConfigMaps
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["go-service-config"]
    verbs: ["get", "watch"]
  # Read Secrets
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["go-service-secrets"]
    verbs: ["get"]
  # Leader election
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "create", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: go-service-rolebinding
  namespace: production
subjects:
  - kind: ServiceAccount
    name: go-service
    namespace: production
roleRef:
  kind: Role
  name: go-service-role
  apiGroup: rbac.authorization.k8s.io
```

### Pod Security Standards

Kubernetes Pod Security Standards replace the deprecated PodSecurityPolicy, enforcing restrictions at the namespace level via admission control labels. The `restricted` profile applied here mandates running as a non-root UID, drops all Linux capabilities, enables a `RuntimeDefault` seccomp profile to restrict syscalls, and forces a read-only root filesystem, together these prevent common container escape techniques such as writing malicious binaries to disk or exploiting privileged syscalls. The `emptyDir` volume for `/tmp` is required because many Go binaries need a writable temp directory even when the root filesystem is locked down.

```yaml
# pod-security/restricted.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
---
# Deployment compliant with restricted policy
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-service
  namespace: production
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
```

### Junior → FAANG: Kubernetes RBAC Fundamentals and Least Privilege

RBAC in Kubernetes is expressed through four objects: ServiceAccount (the identity a pod runs as), Role or ClusterRole (a set of permissions), and RoleBinding or ClusterRoleBinding (the binding of a role to an identity). The principle of least privilege requires that each ServiceAccount has only the permissions it needs for its specific function, nothing more.

The most common junior mistake is using the default ServiceAccount (which often has no explicitly granted permissions and may be bound to broad roles by platform defaults) or creating a ServiceAccount and binding cluster-admin to it "to make it work." Neither is acceptable in a production environment.

For a Go service that does not interact with the Kubernetes API at all, the correct configuration is a dedicated ServiceAccount with no roles bound to it, plus `automountServiceAccountToken: false` in the pod spec (to prevent the API token from being mounted unnecessarily). For a service that needs to list pods in its own namespace (for a health check or leader election), a Role with specifically `get`, `list`, and `watch` on `pods` in that namespace, bound to a dedicated ServiceAccount, is the correct setup.

### Senior @ FAANG: RBAC Architecture and Just-in-Time Access for Production Operations

At staff level, RBAC is the foundation of the cluster's security posture, and its design requires thinking about both the happy path (services running with minimal permissions) and the operational path (engineers needing elevated permissions for incident response).

The production RBAC architecture separates three classes of access: platform team access (cluster-scoped admin rights, access via SSO with MFA, audit logged), development team access (namespace-scoped read-only for observability, write access only via CI/CD, not direct kubectl apply), and incident responder access (elevated namespace-scoped permissions, time-limited via a JIT access system, requiring approval, audit logged). The JIT access system (Teleport, Pomerium, or a custom Kubernetes-native implementation) is the mechanism that enables incident response without giving engineers standing elevated permissions.

The audit log is the security control that makes RBAC effective. Without it, you cannot detect abuse of legitimate permissions. The Kubernetes audit log should capture at minimum: all writes to Secrets, all binding changes (RoleBinding, ClusterRoleBinding), all privileged pod creation, and all exec/attach operations. The audit logs should flow to an immutable log store (separate from the cluster, append-only, with retention appropriate to the compliance requirement) and be monitored for anomalies. Designing this audit architecture and the alert rules on top of it is an L6/L7 security engineering contribution.

---
