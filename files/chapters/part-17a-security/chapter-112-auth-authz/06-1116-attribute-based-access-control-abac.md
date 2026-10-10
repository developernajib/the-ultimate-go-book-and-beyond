## 112.6 Attribute-Based Access Control (ABAC)

ABAC uses attributes (user, resource, environment) for fine-grained access control.

```go
package abac

import (
    "slices"
    "time"
)

type Attributes struct {
    User     UserAttributes
    Resource ResourceAttributes
    Action   string
    Context  ContextAttributes
}

type UserAttributes struct {
    ID         string
    Roles      []string
    Department string
    Level      int
}

type ResourceAttributes struct {
    ID        string
    Type      string
    Owner     string
    Sensitive bool
    Tags      []string
}

type ContextAttributes struct {
    Time      time.Time
    IPAddress string
    Location  string
}

type Policy struct {
    Name      string
    Evaluate  func(attrs Attributes) bool
}

type ABAC struct {
    grants       []Policy // at least one must permit the request
    restrictions []Policy // every one must pass (deny-overrides)
}

func NewABAC() *ABAC {
    abac := &ABAC{}

    // Grant policies: any one of these permits access
    abac.AddGrant(Policy{
        Name: "owner_full_access",
        Evaluate: func(attrs Attributes) bool {
            return attrs.Resource.Owner == attrs.User.ID
        },
    })

    abac.AddGrant(Policy{
        Name: "manager_department_access",
        Evaluate: func(attrs Attributes) bool {
            return attrs.User.Level >= 5 &&
                len(attrs.Resource.Tags) > 0 &&
                attrs.User.Department == attrs.Resource.Tags[0]
        },
    })

    // Restriction policies: all of these must pass regardless of grants
    abac.AddRestriction(Policy{
        Name: "business_hours_only",
        Evaluate: func(attrs Attributes) bool {
            hour := attrs.Context.Time.Hour()
            return hour >= 9 && hour < 17
        },
    })

    abac.AddRestriction(Policy{
        Name: "no_sensitive_data_for_contractors",
        Evaluate: func(attrs Attributes) bool {
            isContractor := slices.Contains(attrs.User.Roles, "contractor")
            return !(isContractor && attrs.Resource.Sensitive)
        },
    })

    return abac
}

func (a *ABAC) AddGrant(policy Policy) {
    a.grants = append(a.grants, policy)
}

func (a *ABAC) AddRestriction(policy Policy) {
    a.restrictions = append(a.restrictions, policy)
}

func (a *ABAC) Authorize(attrs Attributes) bool {
    // Deny-overrides: every restriction must pass
    for _, policy := range a.restrictions {
        if !policy.Evaluate(attrs) {
            return false
        }
    }

    // At least one grant must permit the request
    for _, policy := range a.grants {
        if policy.Evaluate(attrs) {
            return true
        }
    }
    return false
}
```

### Junior → FAANG: When to Use ABAC Instead of RBAC

ABAC (Attribute-Based Access Control) is more expressive than RBAC but more complex to implement and audit. Knowing when ABAC is appropriate is a design decision that comes up in senior interviews.

**Gap to close:** RBAC is appropriate when access decisions can be expressed as "users with role X can perform action Y." ABAC is appropriate when access decisions depend on dynamic attributes of the user, the resource, or the context: "users can edit documents that they own, or that belong to a project they are a member of, if the document was created in the last 30 days." RBAC cannot express this cleanly. ABAC can.

**First-job application:** Start with RBAC. If you find yourself creating more than 10-15 roles because each combination of access requirements needs its own role, consider whether ABAC would be more appropriate. The signal for ABAC is when roles proliferate to capture fine-grained combinations of attributes.

**Interview framing:** When asked to compare RBAC and ABAC, use a concrete example: "RBAC assigns the 'editor' role to a user and the 'editor' role allows editing any document. ABAC assigns attributes to the user (department: engineering) and attributes to the document (department: engineering, visibility: internal) and the policy allows editing when user.department == document.department. ABAC is more granular but requires more policy complexity."

### Senior @ FAANG: ABAC Policy Management and Testing

At senior level, ABAC policies are organizational assets that must be versioned, tested, audited, and managed as carefully as code.

**Policy testing infrastructure:** ABAC policies must be tested before deployment. Test scenarios include: a user who should be allowed access (positive test), a user who should be denied access (negative test), a user in an edge case (boundary condition). Build an ABAC policy test framework that can run hundreds of test scenarios against a policy before it is deployed. Policy changes that break existing scenarios are flagged and require review.

**Policy audit trail:** Every ABAC policy evaluation that results in a denial should be logged with the specific attributes and policy rule that triggered the denial. This audit trail is used for: debugging access issues (why was this user denied?), compliance demonstrations (we can show the specific policy that prevented unauthorized access), and anomaly detection (a sudden spike in denials may indicate a policy change broke a legitimate workflow or may indicate an attack).

**ABAC complexity management:** ABAC policies can become very complex. Define a complexity limit for policies: if a policy requires more than 5 attribute checks, consider splitting it into sub-policies with clear names. Use a policy visualization tool to generate diagrams of the attribute decision tree. Complexity limits and visualization tools prevent policy spaghetti that becomes unmaintainable and unprovable.

---
