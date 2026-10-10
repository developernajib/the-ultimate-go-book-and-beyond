## 102G.5 OPA/Gatekeeper Policy-as-Code

### ConstraintTemplate

OPA Gatekeeper is a Kubernetes admission controller that enforces policies written in Rego. A `ConstraintTemplate` defines a new CRD type and the Rego logic that validates resources of that type, while a `Constraint` instance activates the policy for specific resource kinds and namespaces. This two-level model lets platform teams publish policy templates to a registry and let individual teams install only the constraints appropriate for their namespace, creating a scalable policy-as-code library rather than a monolithic webhook.

```yaml
# constrainttemplate-requiredlabels.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("Missing required labels: %v", [missing])
        }
---
# Apply the constraint: all Deployments need team and cost-center labels
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: deployment-must-have-team
spec:
  match:
    kinds:
      - apiGroups: [apps]
        kinds: [Deployment]
    namespaces: [production, staging]
  parameters:
    labels: [team, cost-center, service-name]
```

### Go OPA Evaluation (Embedded)

The `github.com/open-policy-agent/opa/rego` package lets you compile and evaluate Rego policies in-process without running a separate OPA sidecar or HTTP server, which eliminates a network hop on every policy decision and avoids a single point of failure in your admission path. Calling `PrepareForEval` at startup compiles the Rego module into an optimized query plan once, so subsequent `Eval` calls are microsecond-range lookups rather than repeated parse-and-compile cycles. This pattern is particularly useful in Go-based admission webhooks, CLI tools that enforce image provenance, or release automation that must gate deployments against a registry allowlist without depending on cluster-side infrastructure.

```go
package policy

import (
    "context"
    "fmt"

    "github.com/open-policy-agent/opa/rego"
)

// PolicyEngine evaluates OPA policies in-process (no external OPA server)
type PolicyEngine struct {
    imagePolicy *rego.PreparedEvalQuery
}

func NewPolicyEngine(ctx context.Context) (*PolicyEngine, error) {
    // Compile policy at startup for fast evaluation
    q, err := rego.New(
        rego.Query("data.myorg.images.allow"),
        rego.Module("images.rego", `
            package myorg.images

            # Allow only images from approved registries
            approved_registries := {
                "123456789.dkr.ecr.us-east-1.amazonaws.com",
                "gcr.io/myorg-prod",
            }

            allow {
                image := input.image
                some registry in approved_registries
                startswith(image, registry)
            }

            deny[msg] {
                image := input.image
                not allow
                msg := sprintf("image %q not from approved registry", [image])
            }
        `),
    ).PrepareForEval(ctx)
    if err != nil {
        return nil, fmt.Errorf("compile image policy: %w", err)
    }

    return &PolicyEngine{imagePolicy: &q}, nil
}

func (p *PolicyEngine) CheckImage(ctx context.Context, imageRef string) error {
    results, err := p.imagePolicy.Eval(ctx, rego.EvalInput(map[string]any{
        "image": imageRef,
    }))
    if err != nil {
        return fmt.Errorf("policy evaluation: %w", err)
    }

    if len(results) == 0 || !results[0].Expressions[0].Value.(bool) {
        return fmt.Errorf("image %q denied by policy", imageRef)
    }

    return nil
}
```

---

### Junior → FAANG: Understanding Policy-as-Code for Interviews

The two-level model (ConstraintTemplate plus Constraint instance) is important to understand because it separates policy definition from policy activation. Interviewers asking about Kubernetes security governance want to hear this distinction. The platform team writes the template (once), and individual teams or namespace administrators instantiate it with parameters specific to their workload.

The entry-point interview question is usually: "how do you prevent teams from deploying containers as root in a shared Kubernetes cluster?" The wrong answer is "we told them not to." The right answer is: OPA/Gatekeeper constraint that rejects any pod spec without `runAsNonRoot: true`, applied cluster-wide to all namespaces except kube-system. That answer signals you understand enforcement mechanisms, not just policy documentation.

Prerequisite gap: Rego syntax is unfamiliar to most engineers. The key to reading Rego is understanding that rules succeed when all conditions in the body evaluate to true, and a `violation` rule produces a denial message. The `required - provided` set subtraction in the example above computes missing labels cleanly. You do not need to master Rego writing for an interview, but you need to read it fluently.

First-job habit: whenever you add a new mandatory label or annotation requirement, write it as a ConstraintTemplate first. This forces you to think about what "mandatory" means cluster-wide versus per-namespace, and gives the enforcement a codified form that survives team turnover.

### Senior @ FAANG: Policy Libraries, Drift Detection, and the Governance Lifecycle

At the staff level, OPA/Gatekeeper is a policy runtime, not a policy author. The governance question is who authors policy, who reviews it, how it is tested, how it is deployed, and how drift from the intended state is detected and remediated.

The organizational pattern is a policy library repository, versioned with Git, with a CI pipeline that runs `opa test` against unit tests for each Rego module, `gator test` for Gatekeeper constraint integration tests, and a canary deployment process that applies new constraints in `warn` mode (which logs violations without rejecting) before switching to `deny` mode. This prevents a policy change from breaking existing workloads unexpectedly.

An ADR for the policy library governance model needs to address: who has merge access (typically the platform security team, not individual product teams), how product teams request new policies or exceptions (a formal PR with a justification field), the review SLA, and how policies are deprecated when they are no longer needed.

The embedded OPA evaluation pattern (using `PrepareForEval`) is particularly valuable in admission webhook implementations written in Go. The performance profile matters: webhook responses must complete within a few hundred milliseconds or the Kubernetes API server times out and (depending on `failurePolicy`) either admits or rejects the resource. A compiled policy query that evaluates in microseconds is operationally safe. An embedded OPA instance that re-parses policy on every call is not. The `PrepareForEval` compilation step at startup is the correct pattern, and staff engineers reviewing webhook implementations should verify this is being done.

Policy coverage measurement is an often-overlooked maturity indicator. How do you know your Gatekeeper constraints actually cover all the security controls in your threat model? The answer is a coverage matrix: for each security control requirement (runAsNonRoot, no hostPath, approved registry only, required labels), a corresponding constraint exists and is active in all applicable namespaces. The platform team owns this matrix and reviews it quarterly. A constraint that exists in the template library but is not instantiated in any namespace provides zero protection, and a coverage audit catches this class of gap.

Bar-raiser depth: Gatekeeper's `failurePolicy` on the webhook determines what happens when OPA is unavailable. `Fail` (the secure default) rejects all resources if Gatekeeper is down, which blocks deployments during an OPA outage. `Ignore` admits all resources if Gatekeeper is down, which means your security controls have a window of complete bypass during any OPA disruption. The staff-level answer is `Fail` for security-critical constraints, combined with a high-availability Gatekeeper deployment and an on-call runbook for OPA outages. Knowing this trade-off and being able to defend the configuration choice is the depth that separates a policy implementer from a policy architect.
