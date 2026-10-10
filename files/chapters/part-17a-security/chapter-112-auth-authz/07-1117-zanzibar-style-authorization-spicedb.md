## 112.7 Zanzibar-Style Authorization (SpiceDB)

Google's Zanzibar is a global authorization system. SpiceDB is an open-source implementation.

```go
// Integration with SpiceDB for relationship-based access control
package authz

import (
    "context"

    v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
    "github.com/authzed/authzed-go/v1"
    "github.com/authzed/grpcutil"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// Schema example (in SpiceDB schema language):
// definition user {}
//
// definition document {
//     relation owner: user
//     relation editor: user
//     relation viewer: user
//     permission view = viewer + editor + owner
//     permission edit = editor + owner
//     permission delete = owner
// }

type SpiceDBClient struct {
    client *authzed.Client
}

func NewSpiceDBClient(endpoint, token string) (*SpiceDBClient, error) {
    client, err := authzed.NewClient(
        endpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpcutil.WithInsecureBearerToken(token),
    )
    if err != nil {
        return nil, err
    }

    return &SpiceDBClient{client: client}, nil
}

// CheckPermission verifies if user has permission on resource
func (s *SpiceDBClient) CheckPermission(ctx context.Context, userID, resource, permission string) (bool, error) {
    resp, err := s.client.CheckPermission(ctx, &v1.CheckPermissionRequest{
        Resource: &v1.ObjectReference{
            ObjectType: "document",
            ObjectId:   resource,
        },
        Permission: permission,
        Subject: &v1.SubjectReference{
            Object: &v1.ObjectReference{
                ObjectType: "user",
                ObjectId:   userID,
            },
        },
    })

    if err != nil {
        return false, err
    }

    return resp.Permissionship == v1.CheckPermissionResponse_PERMISSIONSHIP_HAS_PERMISSION, nil
}

// WriteRelationship creates a relationship (e.g., user X is owner of document Y)
func (s *SpiceDBClient) WriteRelationship(ctx context.Context, userID, relation, resourceType, resourceID string) error {
    _, err := s.client.WriteRelationships(ctx, &v1.WriteRelationshipsRequest{
        Updates: []*v1.RelationshipUpdate{
            {
                Operation: v1.RelationshipUpdate_OPERATION_CREATE,
                Relationship: &v1.Relationship{
                    Resource: &v1.ObjectReference{
                        ObjectType: resourceType,
                        ObjectId:   resourceID,
                    },
                    Relation: relation,
                    Subject: &v1.SubjectReference{
                        Object: &v1.ObjectReference{
                            ObjectType: "user",
                            ObjectId:   userID,
                        },
                    },
                },
            },
        },
    })

    return err
}
```

### Junior → FAANG: Zanzibar and Relationship-Based Authorization

Google's Zanzibar paper (published 2019) describes the authorization system that powers Google Docs, YouTube, Google Drive, and other Google products. Understanding its core concepts is increasingly expected at FAANG companies because many of them have implemented similar systems.

**Gap to close:** Zanzibar is a relationship-based authorization system. Instead of assigning roles to users, you model permissions as relationships: "user:alice is owner of document:budget_2025" or "group:engineering has viewer access to folder:technical_docs." Permission inheritance propagates through relationship chains: if alice is the owner of a folder, she has all permissions on all documents in that folder. This model is more expressive than RBAC for sharing and collaboration use cases.

**When to use Zanzibar-style authorization:** Zanzibar is appropriate when permissions are relationship-based and permission graphs are user-controlled (sharing, collaboration, delegated access). RBAC is appropriate when permissions are role-based and centrally controlled. SpiceDB (open-source Zanzibar implementation) is the most production-ready option for Go services. Evaluate it when your RBAC model is accumulating complexity to handle sharing scenarios.

**Interview framing:** When asked "how would you implement document sharing with fine-grained permissions?", describe Zanzibar-style: relationships stored in a graph database, permission checks evaluate the relationship graph, inheritance is computed dynamically. Mention SpiceDB as the Go-compatible open-source implementation. This is the expected answer at any company that has complex sharing features.

### Senior @ FAANG: Zanzibar at Scale: Performance and Consistency

At senior level, Zanzibar authorization systems must handle millions of permission checks per second with low latency and strong consistency guarantees. The engineering challenges are significant.

**Zookie consistency tokens:** Zanzibar uses "zookies" (consistency tokens) to provide read-your-writes consistency for permission checks. When a permission change is made (a document is shared), a zookie representing the state after the change is returned. Subsequent permission checks that include the zookie are guaranteed to reflect the change. This allows Zanzibar to use eventually-consistent read replicas while still providing correct results for latency-sensitive operations. Implement a similar consistency token mechanism in your SpiceDB integration if you require read-your-writes consistency.

**Permission check latency:** A direct permission check in SpiceDB involves a graph traversal. Complex permission graphs (deep inheritance chains, large groups) increase traversal time. Design your permission schema to limit graph depth: a maximum of 3-4 levels of inheritance is a practical limit for sub-millisecond permission checks. Deeper graphs require caching or denormalization strategies.

**Schema evolution:** The SpiceDB schema defines your permission relationships. Changing the schema (adding new relation types, changing inheritance rules) requires a migration that is compatible with existing data. Plan schema changes carefully: backward-compatible changes can be applied without downtime, while breaking changes require a migration process. Treat the SpiceDB schema as a formal API with versioning and migration plans.

---
