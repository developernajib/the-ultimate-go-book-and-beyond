## 102E.12 Helm Library Charts and Chart Dependencies

Library charts and chart dependency management are the foundation of DRY Helm ecosystems. As teams grow past a handful of services, copy-pasting the same Deployment template across 50 charts is unsustainable - library charts solve this by providing shared named templates that any chart can import.

### Library Charts - Shared Helper Templates

A library chart sets `type: library` in `Chart.yaml`, which prevents it from being deployed directly. It only provides named templates for consumers.

```yaml
# my-company/helm-library/Chart.yaml
apiVersion: v2
name: company-lib
description: Shared Helm templates for all company microservices
type: library         # cannot be deployed standalone
version: 1.4.2
```

The `_helpers.tpl` in a library chart follows the same naming convention as regular charts but exposes templates for external use:

```yaml
# my-company/helm-library/templates/_deployment.tpl

{{/*
company-lib.deployment - full production-grade Deployment template.
Usage: {{ include "company-lib.deployment" . }}
Expects values:
  .Values.image.repository, .Values.image.tag
  .Values.replicaCount, .Values.resources
  .Values.service.port
*/}}
{{- define "company-lib.deployment" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "company-lib.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "company-lib.labels" . | nindent 4 }}
    app.kubernetes.io/version: {{ .Values.image.tag | quote }}
spec:
  replicas: {{ .Values.replicaCount | default 2 }}
  selector:
    matchLabels:
      {{- include "company-lib.selectorLabels" . | nindent 6 }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    metadata:
      labels:
        {{- include "company-lib.selectorLabels" . | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      serviceAccountName: {{ include "company-lib.serviceAccountName" . }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 2000
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: {{ .Values.service.port }}
              protocol: TCP
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: http
            initialDelaySeconds: 15
            periodSeconds: 20
            failureThreshold: 3
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    {{- include "company-lib.selectorLabels" . | nindent 20 }}
                topologyKey: kubernetes.io/hostname
{{- end -}}
```

A consuming chart declares the library as a dependency and calls the shared template:

```yaml
# my-service/Chart.yaml
apiVersion: v2
name: my-service
version: 2.1.0
dependencies:
  - name: company-lib
    version: ">=1.4.0"
    repository: "oci://ghcr.io/my-company/helm-charts"
```

```yaml
# my-service/templates/deployment.yaml
{{- include "company-lib.deployment" . }}
```

Running `helm dependency update` downloads and unpacks the library into `charts/`:

```bash
helm dependency update my-service/
# Saving 1 charts
# Downloading company-lib from repo oci://ghcr.io/my-company/helm-charts
# Deleting outdated charts
```

### Chart Dependencies via Chart.yaml

Beyond library charts, umbrella (parent) charts pull in multiple sub-charts to deploy an entire microservice stack as a unit:

```yaml
# platform-stack/Chart.yaml
apiVersion: v2
name: platform-stack
description: Complete e-commerce platform - API, workers, Redis, PostgreSQL
version: 5.0.0
dependencies:
  - name: api-service
    version: "2.x.x"
    repository: "oci://ghcr.io/my-company/helm-charts"
    condition: api.enabled

  - name: order-worker
    version: "1.x.x"
    repository: "oci://ghcr.io/my-company/helm-charts"
    condition: orderWorker.enabled

  - name: redis
    version: "19.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: redis.enabled

  - name: postgresql
    version: "15.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.enabled
    tags:
      - database
```

Values for sub-charts are namespaced under the dependency name:

```yaml
# platform-stack/values.yaml
api:
  enabled: true

orderWorker:
  enabled: true

redis:
  enabled: true
  auth:
    enabled: true
    existingSecret: redis-credentials
  master:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi

postgresql:
  enabled: false  # use external RDS in production

# Sub-chart values - namespaced by chart name
api-service:
  replicaCount: 3
  image:
    repository: ghcr.io/my-company/api-service
    tag: "1.12.0"

order-worker:
  replicaCount: 5
```

### Packaging and Distributing Charts via OCI Registries

OCI (Open Container Initiative) registries (ECR, GHCR, Docker Hub) are the modern standard for distributing Helm charts - no need for a separate chart museum:

```bash
# Login to GHCR
echo $GITHUB_TOKEN | helm registry login ghcr.io -u $GITHUB_USER --password-stdin

# Package the chart
helm package my-service/ --destination ./dist/
# Successfully packaged chart and saved it to: dist/my-service-2.1.0.tgz

# Push to OCI registry
helm push dist/my-service-2.1.0.tgz oci://ghcr.io/my-company/helm-charts

# Pull and inspect
helm pull oci://ghcr.io/my-company/helm-charts/my-service --version 2.1.0
helm show chart oci://ghcr.io/my-company/helm-charts/my-service --version 2.1.0

# Install directly from OCI
helm upgrade --install my-service \
  oci://ghcr.io/my-company/helm-charts/my-service \
  --version 2.1.0 \
  --namespace production \
  --values prod-values.yaml
```

### Helm Plugin Development in Go

Helm plugins extend the CLI with custom commands. The plugin is a standalone executable (here in Go) placed in `~/.local/share/helm/plugins/`:

```go
// cmd/helm-lint-advanced/main.go
// helm-lint-advanced: validates a chart for production-readiness beyond helm lint
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/chartutil"
)

type Finding struct {
	Severity string // ERROR, WARN
	Rule     string
	Message  string
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: helm lint-advanced <chart-path>\n")
		os.Exit(1)
	}

	chartPath := os.Args[1]
	absPath, err := filepath.Abs(chartPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid path: %v\n", err)
		os.Exit(1)
	}

	chrt, err := loader.Load(absPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load chart: %v\n", err)
		os.Exit(1)
	}

	findings := runChecks(chrt)

	errors := 0
	for _, f := range findings {
		fmt.Printf("[%s] %s: %s\n", f.Severity, f.Rule, f.Message)
		if f.Severity == "ERROR" {
			errors++
		}
	}

	if errors > 0 {
		fmt.Printf("\n%d error(s) found - chart is NOT production-ready\n", errors)
		os.Exit(1)
	}
	fmt.Println("\nAll checks passed - chart is production-ready")
}

func runChecks(chrt interface{ Metadata() interface{ Name() string } }) []Finding {
	// Load using concrete type
	c, ok := chrt.(*loader.BufferedFile)
	_ = ok
	_ = c
	// In production: iterate chrt.Templates, chrt.Values, chrt.Metadata
	// and apply rules. Simplified for illustration:
	var findings []Finding

	// Rule 1: chart must have maintainers
	// Rule 2: all containers must have resource limits
	// Rule 3: images must not use :latest tag
	// Rule 4: PodDisruptionBudget must exist
	// Rule 5: NetworkPolicy must exist

	_ = chartutil.CoalesceValues // used for values validation
	findings = append(findings, Finding{
		Severity: "WARN",
		Rule:     "PDB_MISSING",
		Message:  "No PodDisruptionBudget found - add one for zero-downtime deploys",
	})
	return findings
}
```

Plugin descriptor at `~/.local/share/helm/plugins/lint-advanced/plugin.yaml`:

```yaml
name: "lint-advanced"
version: "1.0.0"
usage: "helm lint-advanced <chart-path>"
description: "Production-readiness linter for Helm charts"
command: "$HELM_PLUGIN_DIR/helm-lint-advanced"
```

### Junior → FAANG: Library Charts as the DRY Principle Applied to Infrastructure

The prerequisite concept to understand before library charts makes sense: Helm named templates are Go template functions. A library chart is a package of functions with no main program. When a consuming chart calls `include "company-lib.deployment" .`, it is calling a function defined in a dependency, just like calling a function from an imported Go package.

The interview entry point here is the OCI registry push workflow. Being able to demonstrate that you have published a Helm chart to an OCI registry (GHCR, ECR) and pulled it in another chart's dependency is a concrete experience signal. Walk through the commands: `helm package`, `helm push`, `helm dependency update`. If you can also describe what happens when a library chart version is pinned versus ranged (such as `>=1.4.0`), you are demonstrating version management discipline.

The umbrella chart pattern (the `platform-stack` example) is worth understanding for interview system design questions about "how do you deploy a whole microservice stack." The answer is: a top-level chart that lists all services as dependencies, with values namespaced per sub-chart. This avoids running multiple `helm install` commands that can partially fail and leave the cluster in an inconsistent state.

### Senior @ FAANG: Library Charts as Platform API Surface

At staff level, the library chart is the platform team's most important Helm artifact. It is the mechanism through which platform standards propagate to every service without requiring each team to re-implement them. Every label convention, every security context default, every rolling update strategy is encoded in the library chart and applied automatically when teams use it.

The governance question that determines whether a library chart succeeds or becomes a burden: what is the update and migration process when the library changes? If a breaking change to the library chart requires all 50 consumer charts to be updated simultaneously, the library chart creates tight coupling rather than reducing it. The production pattern is: library chart changes are backward-compatible within a major version, major version bumps are announced with a migration guide, and consumer charts are updated asynchronously over a defined window. The `version: ">=1.4.0"` range dependency shown here is the mechanism for allowing consumers to pick up patch and minor updates automatically while controlling major version adoption.

The OCI registry as a chart distribution mechanism has platform implications. Storing charts in OCI registries alongside container images unifies the artifact supply chain: you can apply the same image signing, vulnerability scanning, and access control policies to charts that you apply to images. At FAANG scale, chart provenance matters: knowing which version of a library chart produced which deployed configuration is a compliance and incident response requirement, not just an operational convenience. OCI manifest digests (immutable references) provide that provenance more reliably than floating version tags.

The Helm plugin development section shows that the Helm CLI is itself extensible. A platform team that enforces chart standards via a `helm lint-advanced` plugin can catch production-readiness problems at chart authoring time rather than at admission time. The principle: shift the detection of policy violations as far left in the development cycle as possible. A developer getting a rejection from their local lint run during authoring is less disruptive than a deployment being blocked by a validating webhook in staging.

---
