## 111.7 Policy-Based Access Control

Implementing fine-grained authorization with Open Policy Agent (OPA).

### OPA Integration in Go

OPA (Open Policy Agent) evaluates Rego policies against a JSON input document, typically the request principal, resource, and action, and returns a structured decision that the Go service enforces. Embedding OPA as a Go library via `github.com/open-policy-agent/opa/v1/rego` (the Rego v1 API introduced with OPA 1.0) avoids a network call to a separate policy server, keeping authorization latency sub-millisecond while still allowing policies to be loaded from files that can be updated at runtime without recompiling. The input document passed to `rego.Eval` should include all attributes needed by the policy (user roles, resource owner, tenant ID) so policies can be written and tested independently of the Go service implementation.

```go
package main

import (
    "context"
    "fmt"

    "github.com/open-policy-agent/opa/v1/rego"
)

// PolicyEngine evaluates authorization policies
type PolicyEngine struct {
    query rego.PreparedEvalQuery
}

// NewPolicyEngine creates a policy engine with Rego policy
func NewPolicyEngine(ctx context.Context, policy string) (*PolicyEngine, error) {
    query, err := rego.New(
        rego.Query("data.authz.allow"),
        rego.Module("authz.rego", policy),
    ).PrepareForEval(ctx)

    if err != nil {
        return nil, err
    }

    return &PolicyEngine{query: query}, nil
}

// Evaluate checks if action is allowed
func (p *PolicyEngine) Evaluate(ctx context.Context, input map[string]any) (bool, error) {
    results, err := p.query.Eval(ctx, rego.EvalInput(input))
    if err != nil {
        return false, err
    }

    if len(results) == 0 {
        return false, nil
    }

    allowed, ok := results[0].Expressions[0].Value.(bool)
    if !ok {
        return false, fmt.Errorf("unexpected result type")
    }

    return allowed, nil
}

// Example Rego policy
const examplePolicy = `
package authz

default allow := false

# Allow if user is admin
allow if {
    input.user.role == "admin"
}

# Allow if user owns the resource
allow if {
    input.user.id == input.resource.owner_id
}

# Allow read access for viewers
allow if {
    input.action == "read"
    input.user.role == "viewer"
}

# Service-to-service authorization
allow if {
    input.source.service == "api-gateway"
    input.target.service == "backend"
    input.action in ["read", "write"]
}
`

// Usage example
func ExamplePolicyEvaluation() {
    ctx := context.Background()

    engine, err := NewPolicyEngine(ctx, examplePolicy)
    if err != nil {
        panic(err)
    }

    // Check authorization
    input := map[string]any{
        "user": map[string]any{
            "id":   "user-123",
            "role": "viewer",
        },
        "action": "read",
        "resource": map[string]any{
            "type":     "document",
            "owner_id": "user-456",
        },
    }

    allowed, err := engine.Evaluate(ctx, input)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Access allowed: %v\n", allowed) // true (viewer can read)
}

func main() {
    ExamplePolicyEvaluation()
}
```

### Junior → FAANG: OPA and Policy-as-Code Fundamentals

Open Policy Agent (OPA) is the most widely adopted policy engine in cloud-native environments. Understanding how to write and test Rego policies is increasingly expected at FAANG companies.

**Gap to close:** Understand the OPA model: policies are written in Rego, a declarative language. Policies receive input (the authorization request: who, what, where) and data (the policy state: user roles, resource permissions). The policy evaluates to a decision (allow, deny, a set of allowed actions). The key property is that policies are testable (write unit tests for your Rego policies), version-controlled (policies live in a git repository), and auditable (every policy decision can be logged).

**First-job application:** When adding authorization to a Go service, evaluate whether OPA is the right choice. OPA is powerful when authorization logic is complex (multiple attributes, dynamic data) or when policies need to be updated without redeploying the service. For simple RBAC (role-based rules that rarely change), a hardcoded policy in Go may be simpler and more performant. Choose OPA when policy complexity justifies the operational overhead.

**Interview framing:** When asked about authorization in a complex microservices system, mention OPA as an option for centralized policy evaluation. Describe the benefit: policies are separated from business logic, can be updated without code deployments, and are testable with `opa test`. Describe the trade-off: adds a network hop (or an in-process library) for each authorization decision and requires operational investment in OPA infrastructure.

### Senior @ FAANG: OPA Governance and Policy Management

At senior level, OPA is a policy platform used by many teams. The governance challenge is ensuring policy consistency, correctness, and coverage across the organization.

**Policy-as-code pipeline:** Store OPA policies in a git repository with a CI pipeline that runs `opa test` on every PR, checks policy coverage, and validates that new policies follow organizational conventions (naming, structure, required test coverage). Deploy policy updates through a controlled pipeline: a PR in the policy repository triggers automated testing, then a rollout to OPA instances across the organization. This is the same discipline applied to application code, applied to policy code.

**Policy bundle distribution:** At scale, OPA instances across hundreds of services need consistent policy updates. Use OPA bundle distribution: the central policy repository publishes signed bundles to a well-known URL, and OPA instances periodically fetch and verify the bundle. Each OPA instance audits the bundle's signature against the trusted signing key before applying it. This provides tamper-evident policy distribution with automatic propagation.

**Zanzibar-style authorization:** For the most complex authorization requirements (relationship-based access control, where permissions propagate through a graph of relationships), evaluate Zanzibar-style systems (SpiceDB, Ory Keto) rather than OPA. Zanzibar-style systems are specifically designed for relationship-based permissions and are more expressive for complex sharing models. Staff engineers evaluate which authorization model fits the product's complexity and recommend the appropriate system.

---
