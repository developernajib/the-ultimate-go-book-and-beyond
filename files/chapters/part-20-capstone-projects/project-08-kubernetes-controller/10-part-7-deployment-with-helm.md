## Part 7: Deployment with Helm

Helm is the standard package manager for Kubernetes, and packaging your operator as a Helm chart makes it easy for users to install, configure, and upgrade. A Helm chart bundles all the Kubernetes manifests your operator needs (Deployment, RBAC roles, ServiceAccount, webhook configuration) into a single installable package with customizable values. In this part, you will create a production-grade Helm chart that includes proper security contexts, pod anti-affinity for spreading replicas across nodes, resource limits, and support for cert-manager to handle webhook TLS certificates automatically.

### Helm Chart Structure
Packaging the operator as a Helm chart simplifies installation by parameterizing RBAC rules, resource limits, image tags, and feature flags. Chart versioning aligns operator and CRD releases so that upgrade procedures are predictable and rollback is possible.

```
helm/postgres-operator/
├── Chart.yaml
├── values.yaml
├── templates/
│   ├── deployment.yaml
│   ├── rbac.yaml
│   ├── service.yaml
│   ├── serviceaccount.yaml
│   ├── webhook.yaml
│   └── _helpers.tpl
└── crds/
    └── database.example.com_postgresclusters.yaml
```

### Chart.yaml

The `Chart.yaml` defines the Helm chart metadata, version, and Kubernetes version constraints:

```yaml
apiVersion: v2
name: postgres-operator
description: PostgreSQL Operator for Kubernetes
type: application
version: 0.1.0
appVersion: "0.1.0"
keywords:
  - postgres
  - database
  - operator
home: https://github.com/example/postgres-operator
sources:
  - https://github.com/example/postgres-operator
maintainers:
  - name: Your Name
    email: your.email@example.com
```

### values.yaml

The `values.yaml` file provides sensible defaults for replica count, image, resources, and leader election that users can override at install time:

```yaml
# Default values for postgres-operator

replicaCount: 2

image:
  repository: your-registry/postgres-operator
  pullPolicy: IfNotPresent
  tag: "0.1.0"

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  annotations: {}
  name: ""

podAnnotations: {}
podLabels: {}

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65532
  fsGroup: 65532

securityContext:
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
  readOnlyRootFilesystem: true

service:
  type: ClusterIP
  port: 443
  metricsPort: 8080

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi

nodeSelector: {}

tolerations: []

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values:
                  - postgres-operator
          topologyKey: kubernetes.io/hostname

livenessProbe:
  httpGet:
    path: /healthz
    port: 8081
  initialDelaySeconds: 15
  periodSeconds: 20

readinessProbe:
  httpGet:
    path: /readyz
    port: 8081
  initialDelaySeconds: 5
  periodSeconds: 10

metrics:
  enabled: true
  serviceMonitor:
    enabled: false
    interval: 30s

webhook:
  enabled: true
  certManager:
    enabled: true
  # If certManager.enabled is false, provide cert and key
  cert: ""
  key: ""

leaderElection:
  enabled: true
  leaseDuration: 15s
  renewDeadline: 10s
  retryPeriod: 2s
```

### templates/deployment.yaml

The deployment guide covers node provisioning, cluster initialization, replication topology configuration, and rolling upgrade procedures. Automated health checks and graceful shutdown logic enable maintenance operations without dropping client connections or losing cached data.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "postgres-operator.fullname" . }}
  labels:
    {{- include "postgres-operator.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "postgres-operator.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/default-container: manager
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      labels:
        {{- include "postgres-operator.labels" . | nindent 8 }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ include "postgres-operator.serviceAccountName" . }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
      - name: manager
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        imagePullPolicy: {{ .Values.image.pullPolicy }}
        command:
        - /manager
        args:
        - --leader-elect={{ .Values.leaderElection.enabled }}
        {{- if .Values.leaderElection.enabled }}
        - --leader-election-lease-duration={{ .Values.leaderElection.leaseDuration }}
        - --leader-election-renew-deadline={{ .Values.leaderElection.renewDeadline }}
        - --leader-election-retry-period={{ .Values.leaderElection.retryPeriod }}
        {{- end }}
        - --health-probe-bind-address=:8081
        - --metrics-bind-address=:8080
        env:
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        ports:
        - name: webhook-server
          containerPort: 9443
          protocol: TCP
        - name: metrics
          containerPort: 8080
          protocol: TCP
        - name: health
          containerPort: 8081
          protocol: TCP
        livenessProbe:
          {{- toYaml .Values.livenessProbe | nindent 10 }}
        readinessProbe:
          {{- toYaml .Values.readinessProbe | nindent 10 }}
        resources:
          {{- toYaml .Values.resources | nindent 10 }}
        securityContext:
          {{- toYaml .Values.securityContext | nindent 10 }}
        volumeMounts:
        - mountPath: /tmp/k8s-webhook-server/serving-certs
          name: cert
          readOnly: true
      volumes:
      - name: cert
        secret:
          defaultMode: 420
          secretName: {{ include "postgres-operator.fullname" . }}-webhook-server-cert
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      terminationGracePeriodSeconds: 10
```

### templates/rbac.yaml

The RBAC template grants the operator the minimum permissions it needs: access to PostgresCluster custom resources, StatefulSets, Services, ConfigMaps, and Events:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ include "postgres-operator.fullname" . }}-manager-role
  labels:
    {{- include "postgres-operator.labels" . | nindent 4 }}
rules:
- apiGroups:
  - database.example.com
  resources:
  - postgresclusters
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - database.example.com
  resources:
  - postgresclusters/finalizers
  verbs:
  - update
- apiGroups:
  - database.example.com
  resources:
  - postgresclusters/status
  verbs:
  - get
  - patch
  - update
- apiGroups:
  - apps
  resources:
  - statefulsets
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - ""
  resources:
  - services
  - configmaps
  - secrets
  - persistentvolumeclaims
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - ""
  resources:
  - pods
  verbs:
  - get
  - list
  - watch
- apiGroups:
  - ""
  resources:
  - events
  verbs:
  - create
  - patch
- apiGroups:
  - batch
  resources:
  - cronjobs
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: {{ include "postgres-operator.fullname" . }}-manager-rolebinding
  labels:
    {{- include "postgres-operator.labels" . | nindent 4 }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: {{ include "postgres-operator.fullname" . }}-manager-role
subjects:
- kind: ServiceAccount
  name: {{ include "postgres-operator.serviceAccountName" . }}
  namespace: {{ .Release.Namespace }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ include "postgres-operator.fullname" . }}-leader-election-role
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "postgres-operator.labels" . | nindent 4 }}
rules:
- apiGroups:
  - ""
  resources:
  - configmaps
  verbs:
  - get
  - list
  - watch
  - create
  - update
  - patch
  - delete
- apiGroups:
  - coordination.k8s.io
  resources:
  - leases
  verbs:
  - get
  - list
  - watch
  - create
  - update
  - patch
  - delete
- apiGroups:
  - ""
  resources:
  - events
  verbs:
  - create
  - patch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ include "postgres-operator.fullname" . }}-leader-election-rolebinding
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "postgres-operator.labels" . | nindent 4 }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ include "postgres-operator.fullname" . }}-leader-election-role
subjects:
- kind: ServiceAccount
  name: {{ include "postgres-operator.serviceAccountName" . }}
  namespace: {{ .Release.Namespace }}
```

### Deployment Instructions

The deployment guide covers node provisioning, cluster initialization, replication topology configuration, and rolling upgrade procedures. Automated health checks and graceful shutdown logic enable maintenance operations without dropping client connections or losing cached data.

```bash
# Build and push the operator image
make docker-build docker-push IMG=your-registry/postgres-operator:0.1.0

# Install the CRDs
kubectl apply -f config/crd/bases/

# Install the operator using Helm
helm install postgres-operator ./helm/postgres-operator \
  --namespace postgres-operator-system \
  --create-namespace \
  --set image.repository=your-registry/postgres-operator \
  --set image.tag=0.1.0

# Verify installation
kubectl get pods -n postgres-operator-system
kubectl get crd postgresclusters.database.example.com

# Create a PostgresCluster
kubectl apply -f config/samples/database_v1alpha1_postgrescluster.yaml

# Check status
kubectl get postgrescluster
kubectl describe postgrescluster sample-cluster
```
