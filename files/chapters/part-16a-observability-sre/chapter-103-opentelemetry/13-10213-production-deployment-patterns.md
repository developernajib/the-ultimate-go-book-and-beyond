## 103.13 Production Deployment Patterns

### Complete Observability Stack with Docker Compose

A local Docker Compose stack that mirrors production (collector, Prometheus, Grafana, Jaeger) lets you develop instrumentation against the real pipeline instead of discovering export problems after deploy.

```yaml
# docker-compose-observability.yaml
services:
  # OpenTelemetry Collector
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.150.0
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
      - "8889:8889"   # Prometheus exporter
      - "13133:13133" # Health check
    depends_on:
      - jaeger
      - prometheus
    networks:
      - observability

  # Jaeger v2 for distributed tracing (the v1 all-in-one is deprecated)
  jaeger:
    image: jaegertracing/jaeger:2.20.0
    ports:
      - "16686:16686" # Jaeger UI
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
    networks:
      - observability

  # Prometheus for metrics
  prometheus:
    image: prom/prometheus:v3.14.0
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.enable-lifecycle'
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    ports:
      - "9090:9090"
    networks:
      - observability

  # Grafana for visualization
  grafana:
    image: grafana/grafana:13.2.1
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning
      - grafana-data:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus
      - jaeger
      - loki
    networks:
      - observability

  # Loki for log aggregation
  loki:
    image: grafana/loki:3.6.13
    command: -config.file=/etc/loki/local-config.yaml
    volumes:
      - ./loki-config.yaml:/etc/loki/local-config.yaml
      - loki-data:/loki
    ports:
      - "3100:3100"
    networks:
      - observability

  # Promtail for log shipping (deprecated upstream in favor of Grafana Alloy,
  # but still published - pin to the matching Loki release train)
  promtail:
    image: grafana/promtail:3.6.13
    command: -config.file=/etc/promtail/config.yaml
    volumes:
      - ./promtail-config.yaml:/etc/promtail/config.yaml
      - /var/log:/var/log:ro
      - app-logs:/app-logs:ro
    depends_on:
      - loki
    networks:
      - observability

  # Example Go application
  api-service:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
      - OTEL_SERVICE_NAME=api-service
      - OTEL_RESOURCE_ATTRIBUTES=service.version=1.0.0,deployment.environment=production
      - LOG_LEVEL=info
    ports:
      - "8080:8080"
    volumes:
      - app-logs:/var/log/app
    depends_on:
      - otel-collector
    networks:
      - observability

volumes:
  prometheus-data:
  grafana-data:
  loki-data:
  app-logs:

networks:
  observability:
    driver: bridge
```

### Production OTel Collector Configuration

The production Collector YAML wires together OTLP receivers (gRPC and HTTP), a `batch` processor with `send_batch_max_size` and `timeout` tuning, a `memory_limiter` processor to prevent OOM under burst traffic, and parallel exporters to Jaeger and an object-storage backend, demonstrating the Collector as a vendor-neutral routing and buffering layer between instrumented services and trace backends.

```yaml
# otel-collector-config.yaml (production)
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        max_recv_msg_size_mib: 16
        max_concurrent_streams: 100
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins:
            - "https://*.mycompany.com"

  # Scrape Prometheus metrics from services
  prometheus:
    config:
      scrape_configs:
        - job_name: 'go-services'
          scrape_interval: 15s
          kubernetes_sd_configs:
            - role: pod
          relabel_configs:
            - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
              action: keep
              regex: true
            - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
              action: replace
              target_label: __metrics_path__
              regex: (.+)

  # Host metrics
  hostmetrics:
    collection_interval: 30s
    scrapers:
      cpu:
      memory:
      disk:
      network:

processors:
  # Memory limiter to prevent OOM
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25

  # Batch processing for efficiency
  batch:
    send_batch_size: 1024
    timeout: 5s
    send_batch_max_size: 2048

  # Add Kubernetes metadata
  k8sattributes:
    auth_type: "serviceAccount"
    passthrough: false
    extract:
      metadata:
        - k8s.namespace.name
        - k8s.deployment.name
        - k8s.pod.name
        - k8s.node.name
      labels:
        - tag_name: app
          key: app
          from: pod
        - tag_name: version
          key: version
          from: pod

  # Resource detection
  resourcedetection:
    detectors: [env, system, gcp, aws, azure]
    timeout: 5s
    override: false

  # Tail-based sampling for traces
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow-traces
        type: latency
        latency:
          threshold_ms: 1000
      - name: probabilistic
        type: probabilistic
        probabilistic:
          sampling_percentage: 5

  # Filter health check endpoints from traces
  filter:
    traces:
      span:
        - 'attributes["http.target"] == "/health"'
        - 'attributes["http.target"] == "/ready"'
        - 'attributes["http.target"] == "/metrics"'

  # Transform processor for attribute modification
  transform:
    trace_statements:
      - context: span
        statements:
          # Truncate long SQL queries
          - truncate_all(attributes, 4096)

exporters:
  # Jaeger for traces (v2 accepts OTLP directly on the jaeger service)
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 5m

  # Prometheus for metrics
  prometheus:
    endpoint: 0.0.0.0:8889
    namespace: myapp
    resource_to_telemetry_conversion:
      enabled: true

  # Loki for logs. Label mapping is driven by the loki.resource.labels /
  # loki.attribute.labels hint attributes set upstream (e.g. via the
  # attributes processor). Loki 3.x also accepts OTLP directly, in which
  # case an otlphttp exporter pointed at Loki's OTLP endpoint replaces this.
  loki:
    endpoint: http://loki:3100/loki/api/v1/push
    default_labels_enabled:
      exporter: true
      job: true

  # Debug exporter for troubleshooting
  debug:
    verbosity: detailed
    sampling_initial: 5
    sampling_thereafter: 200

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
    path: "/health"

  pprof:
    endpoint: 0.0.0.0:1777

  zpages:
    endpoint: 0.0.0.0:55679

# Note: the old memory_ballast extension was removed from the Collector.
# Memory headroom is now managed with the memory_limiter processor plus
# the GOMEMLIMIT environment variable on the container.

service:
  extensions: [health_check, pprof, zpages]

  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, resourcedetection, tail_sampling, filter, batch]
      exporters: [otlp/jaeger]

    metrics:
      receivers: [otlp, prometheus, hostmetrics]
      processors: [memory_limiter, k8sattributes, resourcedetection, batch]
      exporters: [prometheus]

    logs:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, resourcedetection, batch]
      exporters: [loki]

  telemetry:
    logs:
      level: info
      initial_fields:
        service: otel-collector
    metrics:
      level: detailed
      address: 0.0.0.0:8888
```

### Kubernetes Deployment

Running the Collector in Kubernetes takes a ConfigMap for the pipeline configuration, a Deployment with health probes and resource limits, and RBAC so the `k8sattributes` processor can read pod metadata. One caveat on the `replicas: 3` below: tail-based sampling needs all spans of a trace on the same instance, so a multi-replica gateway requires a first-tier Collector using the `loadbalancing` exporter (trace ID routing) in front of it.

```yaml
# otel-collector-k8s.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  config.yaml: |
    # (collector config as above)

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: observability
spec:
  replicas: 3
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
    spec:
      serviceAccountName: otel-collector
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.150.0
          command:
            - "/otelcol-contrib"
            - "--config=/etc/otel-collector-config/config.yaml"
          ports:
            - containerPort: 4317
              name: otlp-grpc
            - containerPort: 4318
              name: otlp-http
            - containerPort: 8889
              name: prometheus
            - containerPort: 13133
              name: health
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          livenessProbe:
            httpGet:
              path: /health
              port: 13133
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 13133
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: config
              mountPath: /etc/otel-collector-config
      volumes:
        - name: config
          configMap:
            name: otel-collector-config

---
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: observability
spec:
  selector:
    app: otel-collector
  ports:
    - name: otlp-grpc
      port: 4317
      targetPort: 4317
    - name: otlp-http
      port: 4318
      targetPort: 4318
    - name: prometheus
      port: 8889
      targetPort: 8889

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: otel-collector
  namespace: observability

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: otel-collector
rules:
  - apiGroups: [""]
    resources: ["pods", "namespaces"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["extensions"]
    resources: ["replicasets"]
    verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: otel-collector
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: otel-collector
subjects:
  - kind: ServiceAccount
    name: otel-collector
    namespace: observability
```

### Junior → FAANG: Understanding Why Deployment Topology Matters

The simplest OTel deployment (app exports directly to Jaeger) works for a single service on a developer laptop. Production requires different thinking. Direct export to a backend means your application code handles connection management, retry logic, and backpressure to the observability backend. If Jaeger is slow, your application waits. If Jaeger restarts, your application accumulates unsent spans in memory until it OOMs.

The sidecar or DaemonSet Collector pattern solves this by decoupling the application from the backend. Your application exports to localhost (fast, reliable, no TLS required), and the Collector handles everything else. First-job habit: always prefer a Collector deployment over direct export, even for small services.

Interview entry point: "What happens to in-flight spans when the OTel Collector restarts?" The batch processor buffers spans in memory. A graceful shutdown with a context deadline flushes the buffer before exit. Spans buffered but not yet flushed are lost. A persistent queue exporter (writing to disk) reduces this loss window at the cost of disk I/O.

### Senior @ FAANG: Multi-Region Collector Topology, HA, and Upgrade Safety

**Multi-region deployment.** In a multi-region system, the Collector fleet must be region-local for traces (to avoid cross-region latency in the hot path) but may aggregate to a global tier for metrics (which are smaller and benefit from unified dashboards). A senior engineer designs the regional Collector fleet with independent failure domains: a regional Collector outage should never affect production services, and traces should degrade gracefully (increased span loss rate) rather than causing service errors.

**Collector HA and leader election.** Standard Collector instances are stateless (for head-based sampling) and can run as horizontally scaled Deployments. Tail-based sampling instances require sticky routing (all spans for a trace must reach the same Collector instance) and cannot be scaled transparently. An L6 engineer evaluates whether the complexity of stateful Collector scaling (using consistent hash load balancing from a stateless first tier) is justified by the sampling policy requirements.

**Zero-downtime Collector upgrades.** A Collector restart during a high-traffic period causes a brief gap in telemetry data. In environments where SLO windows are measured in minutes, a 30-second gap can affect alert accuracy. A senior engineer implements a rolling upgrade strategy: new Collector pods start accepting traffic before old ones are terminated, the first-tier DaemonSet pods drain before the second-tier gateways are upgraded, and the upgrade is validated by monitoring `otelcol_exporter_sent_spans` continuity during the rollout.

**RBAC and network policy for Collector.** The Collector DaemonSet runs with node-level visibility, which is a significant privilege. Its service account must be scoped to the minimum permissions required (read ConfigMaps in the observability namespace, write to the backend endpoint) and must not have cluster-admin or secrets access. Network policy must restrict outbound connections to only the configured backend endpoints, preventing a compromised Collector from being used as a network pivot point.

---
