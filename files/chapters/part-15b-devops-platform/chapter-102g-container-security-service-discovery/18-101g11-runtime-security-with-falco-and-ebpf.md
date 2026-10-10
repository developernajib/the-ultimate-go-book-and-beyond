## 102G.16 Runtime Security with Falco and eBPF

Modern container security cannot rely solely on pre-deployment scanning. Once a container is running, it can be exploited through zero-day vulnerabilities, misconfigured logic, or injected payloads that no static scanner could catch. Runtime security closes this gap by observing actual system call behavior against a known-good baseline.

### How Falco Works

Falco instruments the Linux kernel via eBPF (preferred) or a kernel module to capture every system call made by every process in every container. It then evaluates those calls against a Rego-like rules engine written in YAML. Rules describe "this process should never do that" - and when a container breaks the rule, Falco fires an alert within milliseconds.

```
┌─────────────┐    syscall stream    ┌──────────────────┐
│  Container  │ ─────────────────── ►│  Falco eBPF Probe│
│  Process    │                      │  (kernel side)   │
└─────────────┘                      └────────┬─────────┘
                                              │ enriched event
                                              ▼
                                     ┌──────────────────┐
                                     │  Rules Engine    │
                                     │  (user space)    │
                                     └────────┬─────────┘
                                              │ alert
                                    ┌─────────▼──────────┐
                                    │  Falco Sidekick    │
                                    │  Slack/PD/Webhook  │
                                    └────────────────────┘
```

### Core Falco Rules for Go Services

Falco ships with default rules. For production Go microservices, the following custom rules are essential additions:

```yaml
# /etc/falco/custom_rules.yaml

# Rule 1: Shell spawned inside a Go service container
# Go binaries should never exec a shell - this indicates RCE
- rule: Shell Spawned in Go Service Container
  desc: A shell was executed inside a container running a Go service
  condition: >
    spawned_process and
    container and
    container.image.repository startswith "myregistry.io/services/" and
    proc.name in (shell_binaries)
  output: >
    Shell spawned in Go service container
    (user=%user.name user_loginuid=%user.loginuid
     command=%proc.cmdline pid=%proc.pid
     container_id=%container.id image=%container.image.repository:%container.image.tag
     k8s_pod=%k8s.pod.name k8s_ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [container, shell, attack, rce]

# Rule 2: Write to /etc inside container (persistence attempt)
- rule: Write to /etc in Container
  desc: Unexpected write to /etc - possible config tampering or persistence
  condition: >
    open_write and
    container and
    fd.name startswith /etc and
    not proc.name in (known_etc_writers)
  output: >
    Write to /etc in container
    (user=%user.name command=%proc.cmdline
     file=%fd.name container_id=%container.id
     image=%container.image.repository)
  priority: HIGH
  tags: [container, filesystem, persistence]

# Rule 3: Unexpected outbound connection
# Go services should only connect to known destinations
- rule: Unexpected Outbound Connection from Go Service
  desc: Container making outbound connection to unexpected IP range
  condition: >
    outbound and
    container and
    container.image.repository startswith "myregistry.io/services/" and
    not fd.sip in (allowed_service_cidrs) and
    not fd.sport in (53, 443, 8080, 8443, 9090)
  output: >
    Unexpected outbound connection
    (command=%proc.cmdline
     connection=%fd.name
     container_id=%container.id
     image=%container.image.repository)
  priority: WARNING
  tags: [container, network, c2]

# Rule 4: Read sensitive credentials
- rule: Container Reading Cloud Metadata or Credentials
  desc: Container accessing AWS metadata endpoint or secret files
  condition: >
    (open_read or network_activity) and
    container and
    (fd.name startswith /var/run/secrets or
     fd.name contains "id_rsa" or
     fd.name contains ".aws/credentials" or
     fd.sip = "169.254.169.254")
  output: >
    Credential access in container
    (user=%user.name command=%proc.cmdline
     file=%fd.name container_id=%container.id)
  priority: CRITICAL
  tags: [container, credentials, privilege-escalation]

# Macro: known processes allowed to write /etc
- macro: known_etc_writers
  condition: proc.name in (useradd, groupadd, adduser, dpkg, rpm, apt-get)

# List: allowed CIDR ranges for service mesh
- list: allowed_service_cidrs
  items: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16]
```

### Go Alert Handler - Automated Quarantine via Falco Webhook

Falco Sidekick can POST alerts to any HTTP webhook. This Go service receives those alerts and takes automated action: cordon the affected pod from receiving new traffic and open a PagerDuty incident.

```go
// cmd/falco-handler/main.go
package main

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

// FalcoAlert is the JSON payload Falco Sidekick sends.
type FalcoAlert struct {
    Rule     string            `json:"rule"`
    Priority string            `json:"priority"`
    Output   string            `json:"output"`
    Source   string            `json:"source"`
    Tags     []string          `json:"tags"`
    Time     time.Time         `json:"time"`
    OutputFields map[string]string `json:"output_fields"`
}

// QuarantineThreshold - only auto-quarantine on CRITICAL alerts.
const QuarantineThreshold = "CRITICAL"

type AlertHandler struct {
    k8s       *kubernetes.Clientset
    pdToken   string
    pdService string
    logger    *slog.Logger
}

func NewAlertHandler(logger *slog.Logger) (*AlertHandler, error) {
    cfg, err := rest.InClusterConfig()
    if err != nil {
        return nil, fmt.Errorf("in-cluster config: %w", err)
    }
    client, err := kubernetes.NewForConfig(cfg)
    if err != nil {
        return nil, fmt.Errorf("k8s client: %w", err)
    }
    return &AlertHandler{
        k8s:       client,
        pdToken:   os.Getenv("PAGERDUTY_TOKEN"),
        pdService: os.Getenv("PAGERDUTY_SERVICE_KEY"),
        logger:    logger,
    }, nil
}

func (h *AlertHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    var alert FalcoAlert
    if err := json.NewDecoder(r.Body).Decode(&alert); err != nil {
        http.Error(w, "invalid payload", http.StatusBadRequest)
        return
    }

    h.logger.Info("falco alert received",
        slog.String("rule", alert.Rule),
        slog.String("priority", alert.Priority),
        slog.String("pod", alert.OutputFields["k8s.pod.name"]),
        slog.String("namespace", alert.OutputFields["k8s.ns.name"]),
    )

    ctx := context.Background()

    if alert.Priority == QuarantineThreshold {
        podName := alert.OutputFields["k8s.pod.name"]
        namespace := alert.OutputFields["k8s.ns.name"]

        if podName != "" && namespace != "" {
            if err := h.quarantinePod(ctx, namespace, podName, alert.Rule); err != nil {
                h.logger.Error("quarantine failed",
                    slog.String("pod", podName),
                    slog.String("error", err.Error()),
                )
            } else {
                h.logger.Info("pod quarantined",
                    slog.String("pod", podName),
                    slog.String("namespace", namespace),
                )
            }
        }

        if err := h.openPagerDutyIncident(alert); err != nil {
            h.logger.Error("pagerduty incident failed", slog.String("error", err.Error()))
        }
    }

    w.WriteHeader(http.StatusOK)
}

// quarantinePod labels the pod with quarantine=true so a NetworkPolicy
// selecting on that label drops all ingress/egress traffic.
func (h *AlertHandler) quarantinePod(ctx context.Context, namespace, podName, reason string) error {
    pod, err := h.k8s.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
    if err != nil {
        return fmt.Errorf("get pod: %w", err)
    }

    if pod.Labels == nil {
        pod.Labels = make(map[string]string)
    }
    pod.Labels["security.quarantine"] = "true"
    pod.Labels["security.quarantine-reason"] = sanitizeLabelValue(reason)
    pod.Labels["security.quarantine-time"] = fmt.Sprintf("%d", time.Now().Unix())

    _, err = h.k8s.CoreV1().Pods(namespace).Update(ctx, pod, metav1.UpdateOptions{})
    return err
}

// sanitizeLabelValue truncates and removes chars invalid for k8s label values.
func sanitizeLabelValue(s string) string {
    const max = 63
    var out []byte
    for _, c := range []byte(s) {
        if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' {
            out = append(out, c)
        } else {
            out = append(out, '-')
        }
        if len(out) >= max {
            break
        }
    }
    return string(out)
}

// openPagerDutyIncident posts a v2 Events API alert to PagerDuty.
func (h *AlertHandler) openPagerDutyIncident(alert FalcoAlert) error {
    payload := map[string]any{
        "routing_key":  h.pdService,
        "event_action": "trigger",
        "payload": map[string]any{
            "summary":   fmt.Sprintf("[Falco CRITICAL] %s", alert.Rule),
            "severity":  "critical",
            "source":    alert.OutputFields["container.id"],
            "timestamp": alert.Time.Format(time.RFC3339),
            "custom_details": map[string]string{
                "rule":      alert.Rule,
                "output":    alert.Output,
                "pod":       alert.OutputFields["k8s.pod.name"],
                "namespace": alert.OutputFields["k8s.ns.name"],
                "image":     alert.OutputFields["container.image.repository"],
            },
        },
    }

    b, _ := json.Marshal(payload)
    req, err := http.NewRequest(http.MethodPost, "https://events.pagerduty.com/v2/enqueue",
        bytes.NewReader(b))
    if err != nil {
        return err
    }
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Token token="+h.pdToken)

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusAccepted {
        return fmt.Errorf("pagerduty returned %d", resp.StatusCode)
    }
    return nil
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    handler, err := NewAlertHandler(logger)
    if err != nil {
        logger.Error("init failed", slog.String("error", err.Error()))
        os.Exit(1)
    }

    mux := http.NewServeMux()
    mux.Handle("/alert", handler)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    logger.Info("falco alert handler listening", slog.String("addr", ":8080"))
    if err := srv.ListenAndServe(); err != nil {
        logger.Error("server error", slog.String("error", err.Error()))
        os.Exit(1)
    }
}
```

The matching NetworkPolicy ensures quarantined pods are isolated immediately:

```yaml
# networkpolicy-quarantine.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: quarantine-isolation
  namespace: production
spec:
  podSelector:
    matchLabels:
      security.quarantine: "true"
  policyTypes:
    - Ingress
    - Egress
  # Empty ingress/egress = deny all traffic
```

### eBPF-Based Detection with Cilium Tetragon

Tetragon is Cilium's eBPF-native runtime security component. Unlike Falco (which works at the system call level), Tetragon can enforce policies - not just observe and alert, but actively kill processes that violate policy. It uses `TracingPolicy` CRDs:

```yaml
# tetragon-policy-no-shell.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-shell-exec
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/bash"
                - "/sh"
                - "/dash"
                - "/ash"
          matchNamespaces:
            - namespace: Pid
              operator: NotIn
              values:
                - "host_ns"    # don't block host processes
          matchActions:
            - action: Sigkill  # kill the process immediately
```

Tetragon advantage over Falco: enforcement (SIGKILL) happens in kernel space before the process has a chance to execute. Falco notifies you after the syscall has completed - Tetragon stops it entirely.

---

### Junior → FAANG: Understanding Detect vs. Prevent and Why You Need Both

The Falco/Tetragon comparison maps to a fundamental security concept that interviewers test: the difference between detective and preventive controls. Falco is detective (observe and alert). Tetragon is preventive (observe and block). Seccomp is also preventive (configured statically at container start). Understanding why you might run both Falco and seccomp, or both Falco and Tetragon, is the kind of layered-thinking question that comes up at senior-track interviews.

The automated quarantine via label is an elegant design that juniors should study carefully. Adding `security.quarantine: "true"` to a pod label, combined with a NetworkPolicy that selects on that label, isolates the pod without killing it. The pod remains running (preserving forensic evidence: process state, memory, network connections) but cannot send or receive any traffic. This is the correct first response to a CRITICAL Falco alert: contain without destroy, then investigate, then terminate.

Prerequisite gap: the `quarantinePod` function updates the pod's labels. But pod label updates trigger a re-evaluation by every controller and admission webhook watching that pod. A Kyverno or Gatekeeper mutation webhook that adds labels based on existing labels could interfere. Know that pod label updates are not safe to do without understanding what other controllers are watching pod labels in your cluster.

First-job habit: before deploying any Falco rule to production, run it in `--dry-run` or warning mode for at least one week. Count the alerts per day. If a rule fires more than 10 times per day on legitimate workloads, it needs more specific conditions before it goes to production alerting. Alert fatigue from noisy rules is the most common reason runtime security programs fail in practice.

### Senior @ FAANG: Runtime Security as an Incident Response Platform

At the L6/L7 level, the Go alert handler here is a seed, not a finished product. A production incident response automation platform built on Falco alerts needs to address: multi-tenancy (the handler must know which team owns the affected pod, to route the PagerDuty incident to the correct on-call rotation), rate limiting (if a bad deployment generates 1000 CRITICAL alerts per minute, the handler must not create 1000 PagerDuty incidents), idempotency (if the same pod generates multiple alerts for the same rule in rapid succession, quarantine should be applied once), and circuit breaking on the Kubernetes API (if the K8s API is slow, the alert handler must not block and must queue quarantine actions for retry).

The Tetragon `Sigkill` action is operationally risky because it can kill legitimate processes that match the rule pattern. A shell executed by a legitimate debugging session (even if that session should not exist in a production container) will be killed immediately. The governance question is: who has authority to deploy a Tetragon enforcement policy, and what is the review and approval process? The asymmetry of risk (false positive kills a legitimate process vs. false negative allows an attacker to execute) must be explicitly evaluated per rule. `Sigkill` enforcement is appropriate for rules that have zero false positive rate in the organization's environment (you have verified over 30 days of observe mode that no legitimate process matches the rule).

At FAANG scale, the eBPF overhead of Tetragon is measurable. A Tetragon kprobe on a high-frequency syscall like `sys_read` or `sys_write` can add 1-2 microseconds per call, which compounds to significant overhead on I/O-intensive workloads. Staff engineers deploying Tetragon must benchmark its overhead on representative workloads before production rollout, and must have a rollback plan if overhead exceeds the agreed budget. This is not a theoretical concern: several large-scale Tetragon deployments have encountered 5-15% CPU overhead from overly broad kprobe policies.

The ADR for choosing between Falco and Tetragon is not either/or. The production pattern at organizations with mature runtime security is both: Falco for broad behavioral monitoring and alerting across all namespaces, Tetragon enforcement for the highest-confidence rules (shell exec, specific credential file access) in the highest-sensitivity namespaces (payment processing, PII handling). The organizations that do only Falco have detection without prevention. The organizations that do only Tetragon have enforcement without visibility. Defense in depth applies within the runtime security layer too.

