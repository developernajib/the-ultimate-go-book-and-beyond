## 102E.1 Helm Deep Dive

### Chart Structure

A Helm chart is a directory tree that packages all Kubernetes manifests for an application along with a `Chart.yaml` metadata file and a `values.yaml` with configurable defaults. The `templates/` directory contains Go-template-annotated YAML files that Helm renders into final manifests by substituting values at install time. The `_helpers.tpl` file holds named templates. Reusable snippets like label blocks or full container specs. That reduce duplication across the template files.

```
shopapp-api/
├── Chart.yaml          # chart metadata
├── values.yaml         # default values
├── values.prod.yaml    # production overrides (not a Helm convention - use -f flag)
├── charts/             # sub-charts (dependencies)
├── templates/
│   ├── _helpers.tpl    # named templates (reusable snippets)
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── hpa.yaml
│   ├── serviceaccount.yaml
│   ├── configmap.yaml
│   ├── secret.yaml
│   ├── NOTES.txt       # printed after install
│   └── tests/
│       └── smoke-test.yaml  # helm test
└── .helmignore
```

```yaml
# Chart.yaml
apiVersion: v2
name: shopapp-api
description: ShopApp API service
type: application
version: 1.2.0           # chart version (semver)
appVersion: "2.5.0"      # app version being deployed

dependencies:
  - name: postgresql
    version: "~15.0"
    repository: https://charts.bitnami.com/bitnami
    condition: postgresql.enabled  # can disable with postgresql.enabled=false

  - name: redis
    version: "~18.0"
    repository: https://charts.bitnami.com/bitnami
    condition: redis.enabled
```

### Helpers Template File

The `_helpers.tpl` file contains named Go templates that are shared across all template files in the chart. These helpers centralize the logic for constructing resource names, label blocks, and annotation maps, ensuring every resource in the chart uses identical, consistently-formatted metadata. Any file prefixed with `_` is never rendered directly as a Kubernetes manifest. It exists solely to be called by other templates using the `include` function.

```yaml
# templates/_helpers.tpl
{{/*
Expand the name of the chart.
*/}}
{{- define "shopapp-api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
*/}}
{{- define "shopapp-api.fullname" -}}
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
Common labels - used on every resource
*/}}
{{- define "shopapp-api.labels" -}}
helm.sh/chart: {{ include "shopapp-api.chart" . }}
{{ include "shopapp-api.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels - used in selector and pod template labels
*/}}
{{- define "shopapp-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "shopapp-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "shopapp-api.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "shopapp-api.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
```

### Deployment Template with Best Practices

A production Helm Deployment template includes several non-obvious best practices beyond simply rendering the container spec. The `{{- if not .Values.autoscaling.enabled }}` guard prevents Helm from setting `spec.replicas` when an HPA is managing the count. Otherwise Helm would fight the HPA on every upgrade. The `podAnnotations` hash checksum trick causes Kubernetes to restart pods when a referenced ConfigMap or Secret changes, since Kubernetes does not automatically propagate config changes to running pods.

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "shopapp-api.fullname" . }}
  labels:
    {{- include "shopapp-api.labels" . | nindent 4 }}
  {{- with .Values.deploymentAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "shopapp-api.selectorLabels" . | nindent 6 }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: {{ .Values.deployment.maxSurge | default "25%" }}
      maxUnavailable: {{ .Values.deployment.maxUnavailable | default "0" }}
  template:
    metadata:
      labels:
        {{- include "shopapp-api.selectorLabels" . | nindent 8 }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      annotations:
        # Force pod restart when ConfigMap changes
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      serviceAccountName: {{ include "shopapp-api.serviceAccountName" . }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          securityContext:
            {{- toYaml .Values.securityContext | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ .Values.service.port }}
              protocol: TCP
          {{- with .Values.env }}
          env:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.envFrom }}
          envFrom:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          livenessProbe:
            {{- toYaml .Values.livenessProbe | nindent 12 }}
          readinessProbe:
            {{- toYaml .Values.readinessProbe | nindent 12 }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          {{- with .Values.volumeMounts }}
          volumeMounts:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      {{- with .Values.volumes }}
      volumes:
        {{- toYaml . | nindent 8 }}
      {{- end }}
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
      terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds | default 30 }}
```

### values.yaml

The `values.yaml` file is the public interface of a Helm chart. It documents every configurable knob and provides defaults that make the chart work out of the box for the common case. Keeping values well-documented with inline comments is important because consumers of the chart will read this file to understand what they can customize. Production values that differ from the defaults are supplied via a separate `-f values.prod.yaml` override file or via `--set` flags in the CI deployment command.

```yaml
# values.yaml - defaults for all environments
replicaCount: 2

image:
  repository: myorg/shopapp-api
  pullPolicy: IfNotPresent
  tag: ""  # overridden by --set image.tag=v1.2.0 in CI

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  annotations: {}  # add IAM role annotation for IRSA here

podAnnotations: {}
podLabels: {}

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65534
  fsGroup: 65534

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: [ALL]

service:
  type: ClusterIP
  port: 8080

ingress:
  enabled: false
  className: nginx
  annotations: {}
  hosts:
    - host: shopapp.example.com
      paths:
        - path: /
          pathType: Prefix
  tls: []

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

livenessProbe:
  httpGet:
    path: /health
    port: http
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: http
  initialDelaySeconds: 10
  periodSeconds: 5

autoscaling:
  enabled: false
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

deployment:
  maxSurge: "25%"
  maxUnavailable: "0"

env: []
envFrom: []
volumes: []
volumeMounts: []

nodeSelector: {}
tolerations: []
affinity: {}

terminationGracePeriodSeconds: 30

postgresql:
  enabled: false  # use external DB in production

redis:
  enabled: false  # use external Redis in production
```

### Helm Hooks

Helm hooks run Jobs at specific points in the release lifecycle: `pre-install`, `pre-upgrade`, `post-install`, and `post-upgrade` are the most commonly used. Database migrations are the canonical use case for `pre-upgrade` hooks. You want migrations to complete before the new application code starts serving traffic. The `helm.sh/hook-delete-policy: hook-succeeded` annotation tells Helm to delete the Job after it completes successfully, preventing stale Job resources from accumulating in the cluster.

```yaml
# templates/hooks/db-migrate.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "shopapp-api.fullname" . }}-db-migrate
  labels:
    {{- include "shopapp-api.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  template:
    metadata:
      labels:
        {{- include "shopapp-api.selectorLabels" . | nindent 8 }}
    spec:
      serviceAccountName: {{ include "shopapp-api.serviceAccountName" . }}
      restartPolicy: Never
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          command: ["./migrate", "--direction=up"]
          envFrom:
            - secretRef:
                name: {{ include "shopapp-api.fullname" . }}-secrets
  backoffLimit: 3
```

### Helm Test

`helm test` runs any Pods or Jobs annotated with `helm.sh/hook: test` after an install or upgrade, providing a built-in smoke test mechanism. A passing test confirms that the deployed release is functional at a basic level. The chart's own integration test. Tests are run on demand with `helm test <release-name>` and their logs are available via `kubectl logs`, making them useful as a post-deployment verification gate in CD pipelines.

```yaml
# templates/tests/smoke-test.yaml
apiVersion: v1
kind: Pod
metadata:
  name: {{ include "shopapp-api.fullname" . }}-smoke-test
  labels:
    {{- include "shopapp-api.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": test
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  restartPolicy: Never
  containers:
    - name: smoke-test
      image: curlimages/curl:latest
      command:
        - sh
        - -c
        - |
          # Test health endpoint
          curl -sf http://{{ include "shopapp-api.fullname" . }}:{{ .Values.service.port }}/health
          echo "Health check passed"

          # Test ready endpoint
          curl -sf http://{{ include "shopapp-api.fullname" . }}:{{ .Values.service.port }}/ready
          echo "Readiness check passed"
```

```bash
# Run tests after install
helm test shopapp-api --namespace production
```

### Junior → FAANG: Helm as More Than a Templating Tool

The gap between "I've used Helm" and "I understand Helm" often comes down to the release lifecycle. Helm tracks every install and upgrade as a versioned release, stored as a Secret in the namespace. `helm rollback` works because Helm keeps the previous rendered manifests, not because it takes a snapshot of the cluster state. Understanding this distinction matters: if something was applied outside Helm (via kubectl), Helm's rollback will not undo it.

The interview entry point for Helm is the HPA replica guard shown in this section. Interviewers will sometimes ask "what happens if you use Helm with an HPA and you don't handle the replica count?" The answer is that Helm will reset replicas to the value in values.yaml on every upgrade, fighting the HPA. Being able to explain why the `if not .Values.autoscaling.enabled` guard exists demonstrates real usage experience, not just documentation reading.

The checksum annotation pattern is another genuine experience signal. Kubernetes does not watch ConfigMaps and restart dependent Pods automatically. The annotation trick causes a pod template change whenever the ConfigMap changes, which triggers a rolling restart. Knowing this pattern and knowing why it exists shows you have debugged stale config problems in production.

### Senior @ FAANG: Helm Chart Governance at Platform Scale

When a platform team owns charts that dozens of application teams consume, the chart's values.yaml is a public API. Breaking changes to values schema are not a Helm concern, they are a migration concern. Senior platform engineers version charts with semantic versioning discipline: major version bumps for breaking values changes, with a deprecation notice in the previous minor version and a migration guide. Helm's `deprecated` field in Chart.yaml is a weak signal. Strong governance requires a communication process.

The `_helpers.tpl` label standard has organizational implications. Every chart in a platform that uses different label conventions creates inconsistent observability. When a team's Prometheus queries use `app.kubernetes.io/name` and another team's chart uses a custom label, aggregation breaks. A platform-level Helm library chart (see the library chart section) that enforces `app.kubernetes.io/` standard labels across all charts is how mature platform teams solve this. The library chart becomes the single source of truth for label conventions.

Hook design deserves explicit ADR treatment. Using `pre-upgrade` hooks for database migrations is the common pattern, but it has a failure mode: if the migration job fails, the upgrade halts, and the cluster is left with the old application version but potentially a partially-applied migration. Idempotent migrations using tools like golang-migrate with `IF NOT EXISTS` guards are a prerequisite, not optional. The ADR should document this requirement and link to the migration tooling standard.

Helm test is underused in production pipelines. At mature platform teams, `helm test` is run as a blocking gate in the CD pipeline, not as an optional post-install check. The test pod should exercise real application behavior, including an authenticated API call, not just a health endpoint. Separating liveness (is the process alive) from functional correctness (does it return correct data) is the key distinction between a test that catches deployment failures and one that just confirms the container started.
