## 102D.3 Blue/Green Deployments

### Native Kubernetes Blue/Green

Blue/green deployment runs two identical production environments simultaneously. Blue carries live traffic, green hosts the new version. Traffic is cut over atomically by updating the Service selector from `version: blue` to `version: green`, giving instant rollback capability simply by reverting the selector. The native Kubernetes approach requires no special controllers, but managing the cutover script and smoke tests is manual. Argo Rollouts (shown below) automates analysis and promotion.

```yaml
# Blue deployment (current production)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shopapp-api-blue
  labels:
    app: shopapp-api
    version: blue
spec:
  replicas: 5
  selector:
    matchLabels:
      app: shopapp-api
      version: blue
  template:
    metadata:
      labels:
        app: shopapp-api
        version: blue
    spec:
      containers:
        - name: api
          image: myorg/shopapp-api:v1.5.0
---
# Green deployment (new version)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shopapp-api-green
  labels:
    app: shopapp-api
    version: green
spec:
  replicas: 5
  selector:
    matchLabels:
      app: shopapp-api
      version: green
  template:
    metadata:
      labels:
        app: shopapp-api
        version: green
    spec:
      containers:
        - name: api
          image: myorg/shopapp-api:v1.6.0
---
# Service: points to blue initially
apiVersion: v1
kind: Service
metadata:
  name: shopapp-api
spec:
  selector:
    app: shopapp-api
    version: blue    # ← change to "green" to switch traffic
  ports:
    - port: 80
      targetPort: 8080
```

```bash
# Blue/Green cutover script
#!/bin/bash
set -e

NEW_VERSION=$1
NAMESPACE=${2:-production}

echo "Deploying green: $NEW_VERSION"
kubectl set image deployment/shopapp-api-green api=myorg/shopapp-api:$NEW_VERSION -n $NAMESPACE

echo "Waiting for green to be ready..."
kubectl rollout status deployment/shopapp-api-green -n $NAMESPACE --timeout=5m

echo "Running smoke tests against green..."
kubectl run smoke-test --rm -it --restart=Never \
  --image=myorg/smoke-tests:latest \
  -- --endpoint=http://shopapp-api-green.$NAMESPACE.svc

echo "Switching traffic to green..."
kubectl patch service shopapp-api -n $NAMESPACE \
  -p '{"spec":{"selector":{"version":"green"}}}'

echo "Traffic switched. Monitoring for 5 minutes..."
sleep 300

# Check error rate (requires metrics-server or Prometheus)
ERROR_RATE=$(kubectl exec -n monitoring prometheus-0 -- \
  promtool query instant \
  'rate(http_requests_total{status=~"5..",version="green"}[5m]) / rate(http_requests_total{version="green"}[5m])')

if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
  echo "ERROR RATE TOO HIGH ($ERROR_RATE). Rolling back to blue..."
  kubectl patch service shopapp-api -n $NAMESPACE \
    -p '{"spec":{"selector":{"version":"blue"}}}'
  exit 1
fi

echo "Green is healthy. Scaling down blue..."
kubectl scale deployment/shopapp-api-blue --replicas=0 -n $NAMESPACE
```

### Argo Rollouts Blue/Green

Argo Rollouts replaces the Kubernetes `Deployment` with a `Rollout` resource that natively understands blue/green and canary strategies. The controller automatically creates the green preview deployment, routes test traffic to the `previewService`, runs pre- and post-promotion analysis queries against Prometheus, and waits for a manual `kubectl argo rollouts promote` command before switching the active service. This eliminates the custom bash scripts shown above and gives you a structured audit trail in the Rollout status.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: shopapp-api
spec:
  replicas: 5
  selector:
    matchLabels:
      app: shopapp-api
  template:
    metadata:
      labels:
        app: shopapp-api
    spec:
      containers:
        - name: api
          image: myorg/shopapp-api:v1.6.0
          ports:
            - containerPort: 8080

  strategy:
    blueGreen:
      # Service for active (live) traffic
      activeService: shopapp-api-active
      # Service for preview (new version) traffic
      previewService: shopapp-api-preview
      # Require manual promotion (don't auto-switch)
      autoPromotionEnabled: false
      # Scale down old version after this delay post-promotion
      scaleDownDelaySeconds: 30
      # Run analysis before auto-promotion (if autoPromotionEnabled=true)
      prePromotionAnalysis:
        templates:
          - templateName: success-rate
        args:
          - name: service-name
            value: shopapp-api-preview
      postPromotionAnalysis:
        templates:
          - templateName: success-rate
        args:
          - name: service-name
            value: shopapp-api-active
```

```bash
# Manually promote blue/green rollout
kubectl argo rollouts promote shopapp-api -n production

# Abort and rollback
kubectl argo rollouts abort shopapp-api -n production

# Watch rollout progress
kubectl argo rollouts get rollout shopapp-api --watch -n production
```

### Junior → FAANG: Choosing Blue/Green Over Rolling for Your First Service

Blue/green is the correct default for services with breaking database schema changes. If v2 of your service requires a column that v1 does not write, you cannot run v1 and v2 simultaneously: rolling update will do exactly that during the transition window. Blue/green avoids this by running only one version at a time against the production database.

The practical steps for a first implementation without Argo Rollouts: deploy the green Deployment, wait for it to be fully ready with `kubectl rollout status`, run your smoke tests against the green Service directly, then update the main Service selector. If smoke tests fail, do nothing: blue is still receiving traffic. This is the safest deployment pattern for services you are not yet confident about.

Entry-level interview framing: when asked about blue/green, mention the cost trade-off. You are running double the infrastructure during the rollout window. For a service with 50 pods, blue/green means 100 pods running simultaneously. This is acceptable for short rollout windows but needs to be considered for services with expensive GPU or memory requirements.

### Senior @ FAANG: Blue/Green as a Database Migration Coordination Pattern

The most important senior insight about blue/green is that it is not primarily a traffic routing pattern. It is a coordination primitive for database migrations. At FAANG scale, the expand-contract migration pattern is mandatory for any production schema change, and blue/green is the deployment strategy that makes it safe.

The expand phase adds the new column as nullable, deploys v2 code that writes to both old and new columns, and runs blue/green to switch traffic without touching the database structure. The contract phase, deployed as a second blue/green cycle after all pods are confirmed running v2, drops the old column. This two-cycle approach means rollback is always possible: if the green v2 has problems, reverting the Service selector brings back v1, which is still writing to the old column structure.

At staff level, the question is not how to implement blue/green but how to enforce the expand-contract pattern across 200 engineering teams who each have their own database migration process. The answer is platform enforcement: require every production deployment with a database migration to be classified as `migration-type: expand` or `migration-type: contract`, and use an admission webhook that rejects deployments with `migration-type: breaking` against databases that have traffic. This makes the correct pattern the path of least resistance rather than optional guidance.

The `prePromotionAnalysis` in Argo Rollouts is the automated equivalent of a QA sign-off. For financial services organizations with strict change management requirements, `autoPromotionEnabled: false` combined with a required Jira change ticket ID in the Rollout annotations creates an auditable gate: no production traffic switch without an approved change record. This is a concrete implementation of SOC 2 change management controls through GitOps tooling rather than through manual process enforcement.

---
