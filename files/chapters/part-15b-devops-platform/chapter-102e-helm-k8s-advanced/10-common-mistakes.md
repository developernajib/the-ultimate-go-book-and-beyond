## 102E.8 Mid-Chapter Synthesis: Helm & Kubernetes Anti-Patterns

### 1. Not Using Named Templates (_helpers.tpl)

Copy-pasting label blocks across every Helm template is fragile: a single rename requires edits in dozens of places and version drift is almost inevitable. The `_helpers.tpl` file exists precisely for this: define a named template once and include it everywhere with `include`, so a label change propagates automatically across the entire chart.

```yaml
# WRONG: copy-pasting labels in every template
# deployment.yaml
metadata:
  labels:
    app: shopapp-api
    version: "1.2.0"
# service.yaml
metadata:
  labels:
    app: shopapp-api
    version: "1.2.0"
# (repeated 10+ times)

# CORRECT: define once in _helpers.tpl
{{- define "app.labels" -}}
app: {{ .Chart.Name }}
version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}
# Use everywhere: {{- include "app.labels" . | nindent 4 }}
```

### 2. Not Setting failurePolicy on Webhooks

When a validating or mutating webhook becomes unavailable, the API server must decide whether to admit or reject the request. And the default `failurePolicy: Fail` means an outage in your webhook blocks all matching operations across the entire cluster. Matching the failure policy to the criticality of the webhook (permissive for convenience mutations, strict for security enforcement) prevents a non-critical component from becoming a blast-radius single point of failure.

```yaml
# WRONG: webhook down = ALL pod creation blocked
failurePolicy: Fail  # default

# CORRECT for non-critical mutations: ignore failures
failurePolicy: Ignore
timeoutSeconds: 3  # fail fast, don't block pods for long

# CORRECT for security-critical validations: fail closed
failurePolicy: Fail
timeoutSeconds: 10
# Ensure the webhook itself is highly available (3+ replicas)
```

### 3. KEDA ScaledObject Without Proper TriggerAuthentication

Omitting a `TriggerAuthentication` forces KEDA to fall back to the node's IAM role, which grants SQS (or whichever trigger resource) access to every workload running on that node. A serious least-privilege violation. A dedicated `TriggerAuthentication` resource backed by IRSA scopes the credentials to the exact KEDA operator, keeping each workload's access boundary tight.

```yaml
# WRONG: credentials hardcoded or unmanaged
triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: ...
      # No auth = uses node IAM role (security risk: all pods get SQS access)

# CORRECT: use TriggerAuthentication with specific IAM role
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: keda-aws-auth
spec:
  podIdentity:
    provider: aws  # uses IRSA (IAM Roles for Service Accounts)
```

### 4. Missing DNS Egress in NetworkPolicy

A restrictive egress `NetworkPolicy` that whitelists only application-level destinations will silently break all hostname-based connections because DNS queries to `kube-dns` on port 53 are blocked along with everything else. Every egress policy that is not explicitly permit-all must include an explicit rule allowing UDP and TCP on port 53 so name resolution continues to work.

```yaml
# WRONG: deny-all egress without DNS exception breaks DNS resolution
spec:
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: database

# CORRECT: always include DNS exception
spec:
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: database
    - ports:  # DNS resolution - CRITICAL
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

### 5. ResourceQuota Without LimitRange

A `ResourceQuota` caps the total resources a namespace may consume, but it only counts pods that explicitly declare resource requests and limits. Without a `LimitRange` supplying defaults, pods deployed without resource specifications are invisible to the quota and can freely exhaust node capacity, making the quota meaningless in practice.

```yaml
# Without LimitRange, ResourceQuota for requests.cpu still works
# but pods without resource requests don't count against quota
# → pods with no limits can consume unlimited resources

# ALWAYS pair ResourceQuota with LimitRange to set defaults
```

### Junior → FAANG: Common Mistakes as a Debugging Mental Model

The five mistakes documented here are all real production failure modes. The value of studying them is not memorization but pattern recognition. Each mistake has a structure: a plausible shortcut that works in development, and a production failure mode that only appears under specific conditions.

The HPA replica guard mistake (not using `if not .Values.autoscaling.enabled`) is particularly instructive. The failure mode is subtle: your pods scale up correctly, but on the next Helm upgrade, replicas reset to the values.yaml default. This does not cause an immediate outage but silently reverts the autoscaler's scaling decision. This category of mistake, where a tool "wins" a race against another tool, is common in complex systems and worth understanding deeply.

The DNS egress mistake is a good first-job litmus test. If you have ever applied a default-deny egress NetworkPolicy and then debugged why all DNS resolution broke, you will never forget the DNS exception. If you have not, you are likely to repeat this mistake the first time you configure a NetworkPolicy. The correct habit is to always include the DNS exception as a template, not as something you add after debugging.

### Senior @ FAANG: Mistakes as System Design Red Flags

At staff level, each of these mistakes represents a category of system design question. The `failurePolicy` question (mistake 2) maps to the reliability vs. security trade-off question: what is the right failure mode for a control plane component, and who makes that decision? The answer depends on the threat model and the recovery time objective, and it should be documented, not left to the engineer who last touched the webhook configuration.

The KEDA authentication mistake (mistake 3) maps to a broader principle: least-privilege credential binding is the default, not an optional hardening step. Node IAM roles that grant broad permissions to all pods on a node violate least-privilege in a way that is invisible until a compromised pod pivots to attack other AWS services. The production pattern is IRSA (IAM Roles for Service Accounts) with a dedicated role per workload, scoped to exactly the resources that workload needs. This should be an admission webhook rule, not a documentation request.

The ResourceQuota without LimitRange mistake (mistake 5) surfaces a deeper design issue: quota systems only work when they count everything. In Kubernetes, they count resources only for pods that declare them. A LimitRange is not just a convenience default. It is the mechanism that closes the accounting gap. Knowing this interdependency and being able to explain it without prompting is a signal that you have operated multi-tenant Kubernetes at production scale.

---
