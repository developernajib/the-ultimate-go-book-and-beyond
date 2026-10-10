## 98.12 Helm Charts for Go Applications

### Chart Structure

A well-organized Helm chart separates concerns across dedicated template files so that each Kubernetes resource can be reasoned about, tested, and overridden independently. This layout follows the standard Helm convention with a `templates/` directory containing one file per resource kind, a `charts/` subdirectory for subcharts such as PostgreSQL, and environment-specific value overrides in a separate `values-production.yaml` file.

```
myapp-chart/
├── Chart.yaml
├── values.yaml
├── values-production.yaml
├── templates/
│   ├── _helpers.tpl
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── hpa.yaml
│   ├── pdb.yaml
│   ├── configmap.yaml
│   ├── secret.yaml
│   └── serviceaccount.yaml
└── charts/
```

### Chart.yaml

`Chart.yaml` is the manifest that describes the chart itself, including its name, version, and the application version it deploys. The `dependencies` block here conditionally pulls in the Bitnami PostgreSQL subchart only when `postgresql.enabled` is true, keeping the chart composable and avoiding unnecessary resources in environments that use an external database.

```yaml
# Chart.yaml
apiVersion: v2
name: go-service
description: A Helm chart for deploying Go microservices
type: application
version: 1.0.0
appVersion: "1.0.0"
keywords:
  - go
  - microservice
  - api
maintainers:
  - name: Platform Team
    email: platform@example.com
dependencies:
  - name: postgresql
    version: "12.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.enabled
```

### values.yaml

The default values file defines the baseline configuration for every deployment of this chart, including sensible resource requests and limits, a pod disruption budget, and Prometheus scrape annotations that enable automatic metrics discovery. Security-hardened defaults are baked in here (running as a non-root user, dropping all Linux capabilities, and enforcing a read-only root filesystem), so every environment inherits a secure baseline unless explicitly overridden.

```yaml
# values.yaml - Default values
replicaCount: 3

image:
  repository: myregistry/go-service
  tag: "latest"
  pullPolicy: IfNotPresent

imagePullSecrets: []

serviceAccount:
  create: true
  annotations: {}
  name: ""

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8080"
  prometheus.io/path: "/metrics"

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65534
  fsGroup: 65534

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL

service:
  type: ClusterIP
  port: 80
  targetPort: 8080

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: api.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: api-tls
      hosts:
        - api.example.com

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 20
  targetCPUUtilizationPercentage: 70
  targetMemoryUtilizationPercentage: 80

pdb:
  enabled: true
  minAvailable: 2

nodeSelector: {}

tolerations: []

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: go-service
          topologyKey: kubernetes.io/hostname

config:
  LOG_LEVEL: info
  ENVIRONMENT: development
  HTTP_TIMEOUT: "30s"

secrets:
  DATABASE_URL: ""
  API_KEY: ""

# External dependencies
postgresql:
  enabled: false
  auth:
    database: myapp
    username: myapp

redis:
  enabled: false
```

### Deployment Template

The Deployment template uses Helm's `include` helper and `nindent` pipeline to compose labels and names consistently across all resources without duplication. A notable production detail is the `checksum/config` and `checksum/secret` annotations, these force a rolling restart whenever a ConfigMap or Secret changes, ensuring pods always run with the latest configuration even when the image tag has not changed. The `preStop` sleep and `topologySpreadConstraints` together guarantee zero-downtime rolling updates and even distribution of replicas across availability zones.

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "go-service.fullname" . }}
  labels:
    {{- include "go-service.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "go-service.selectorLabels" . | nindent 6 }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      labels:
        {{- include "go-service.selectorLabels" . | nindent 8 }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ include "go-service.serviceAccountName" . }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      terminationGracePeriodSeconds: 30
      containers:
        - name: {{ .Chart.Name }}
          securityContext:
            {{- toYaml .Values.securityContext | nindent 12 }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .Values.service.targetPort }}
              protocol: TCP
          envFrom:
            - configMapRef:
                name: {{ include "go-service.fullname" . }}
            - secretRef:
                name: {{ include "go-service.fullname" . }}
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: GOMAXPROCS
              valueFrom:
                resourceFieldRef:
                  resource: limits.cpu
          livenessProbe:
            httpGet:
              path: /health/live
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health/ready
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
      volumes:
        - name: tmp
          emptyDir: {}
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
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              {{- include "go-service.selectorLabels" . | nindent 14 }}
```

### Helpers Template

The `_helpers.tpl` file centralizes reusable named templates that every other chart template calls via `include`, eliminating duplicated label and naming logic. The `go-service.fullname` helper implements the standard Helm convention of truncating names to 63 characters and deduplicating the release name from the chart name, which prevents Kubernetes label length violations when charts are installed with long release names.

```yaml
# templates/_helpers.tpl
{{/*
Expand the name of the chart.
*/}}
{{- define "go-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "go-service.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "go-service.labels" -}}
helm.sh/chart: {{ include "go-service.chart" . }}
{{ include "go-service.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "go-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "go-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "go-service.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "go-service.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
```

### Deploying with Helm

These `helm` CLI commands cover the full release lifecycle, from initial installation with environment-specific value overrides, through in-place upgrades that change only the image tag, to immediate rollback to a previous revision when a bad deployment is detected. The `--set` flag injects secrets at install time without storing them in version-controlled values files, and `helm get values` provides a quick audit of what configuration is currently running in a namespace.

```bash
# Install chart
helm install my-app ./myapp-chart -n production

# Install with custom values
helm install my-app ./myapp-chart \
  -n production \
  -f values-production.yaml \
  --set image.tag=v1.2.3 \
  --set secrets.DATABASE_URL="postgres://..."

# Upgrade
helm upgrade my-app ./myapp-chart \
  -n production \
  --set image.tag=v1.2.4

# Rollback
helm rollback my-app 1 -n production

# List releases
helm list -n production

# Check values
helm get values my-app -n production
```

### Junior → FAANG: Helm Fundamentals for Go Service Deployment

Helm is the package manager for Kubernetes, and understanding it is necessary for any team that deploys third-party software (databases, observability tools, ingress controllers) to Kubernetes. For first-party Go services, Helm provides parameterized deployment templates that can target multiple environments with a single chart.

The key concepts to internalize: a chart is a directory structure with templates and a `values.yaml` that provides defaults. `helm install` renders the templates with the provided values and applies the result to the cluster, tracking the release state. `helm upgrade` updates a release with new values or a new chart version. `helm rollback` reverts to a previous release revision. The release history is stored in Kubernetes Secrets in the target namespace.

First-job habit: always run `helm template` before `helm install` to inspect the rendered YAML. This is the equivalent of `kustomize build` for Kustomize and prevents deploying templates with incorrect values. Also use `helm diff upgrade` (the diff plugin) before upgrading an existing release to see exactly what will change.

### Senior @ FAANG: Helm Chart Governance and the First-Party Versus Third-Party Split

At staff level, the Helm governance question is: who owns the charts, how are they versioned and distributed, and how do teams consume updates?

For third-party software, the answer is straightforward: use the upstream chart from the vendor's or community's Helm repository, pin the chart version and the values in GitOps, and review updates before applying. For first-party services, there are two models. One model is a single generic "go-service" chart maintained by the platform team that covers all standard Go services, parameterized by values that each service provides. This reduces duplication and ensures platform-level concerns (security contexts, resource defaults, observability sidecars) are applied consistently. The other model is per-service charts, giving teams full flexibility. The platform-centric model is strongly preferred for organizations above 20-30 services because the duplication and drift in per-service charts becomes unmanageable.

The chart versioning and distribution model matters for GitOps compatibility. A chart stored in the same repository as the application source is the simplest approach but makes it harder to share the chart across multiple services. A chart published to an OCI registry (Helm 3 supports OCI as a chart registry) or a Helm repository allows sharing and versioning independently. The staff engineering decision is which model to adopt and how to manage the upgrade lifecycle when the shared chart changes in a way that requires application changes.

---
