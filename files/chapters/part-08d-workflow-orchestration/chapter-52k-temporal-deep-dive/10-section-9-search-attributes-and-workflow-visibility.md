## Section 9: Search Attributes and Workflow Visibility

Search attributes are custom indexed fields on workflow executions that enable filtering and listing from the Temporal Web UI or API. They answer operational questions like "show me all orders for customer X that are still running." Search attributes must be registered in the Temporal namespace before use, and the workflow updates them with `UpsertSearchAttributes` as it progresses through states.

```go
package orderworkflow

import (
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// Search attribute keys - must be registered in the Temporal namespace before use.
// Registration: tctl namespace update --search_attr_key "CustomerID=Keyword,OrderStatus=Keyword,OrderValue=Int"
const (
	SACustomerID   = "CustomerID"   // type: Keyword (exact match)
	SAOrderStatus  = "OrderStatus"  // type: Keyword
	SAOrderValue   = "OrderValue"   // type: Int
	SACreatedAt    = "CreatedDate"  // type: Datetime (built-in)
)

// OrderWorkflowWithAttributes is like OrderWorkflow but maintains searchable metadata.
func OrderWorkflowWithAttributes(ctx workflow.Context, input OrderInput) (OrderResult, error) {
	// Set search attributes at start so the workflow is immediately searchable.
	if err := workflow.UpsertSearchAttributes(ctx, map[string]any{
		SACustomerID:  input.CustomerID,
		SAOrderStatus: "pending",
		SAOrderValue:  input.EstimatedValueCents,
	}); err != nil {
		workflow.GetLogger(ctx).Error("set search attributes", "error", err)
		// Non-fatal - continue without search attributes
	}

	// ... execute activities ...

	// Update status when order is confirmed.
	_ = workflow.UpsertSearchAttributes(ctx, map[string]any{
		SAOrderStatus: "confirmed",
	})

	// ... rest of workflow ...

	_ = workflow.UpsertSearchAttributes(ctx, map[string]any{
		SAOrderStatus: "completed",
	})

	return OrderResult{OrderID: input.OrderID, Status: "completed"}, nil
}
```

Once search attributes are set, you can query workflows programmatically using Temporal's visibility query language (backed by Elasticsearch for advanced queries). The following client code lists all active orders for a specific customer:

```go
func listActiveOrdersForCustomer(c client.Client, customerID string) ([]*workflow.WorkflowExecutionInfo, error) {
	// Temporal visibility query language (Elasticsearch-backed for advanced queries)
	query := fmt.Sprintf(`WorkflowType = "OrderWorkflowWithAttributes" AND CustomerID = "%s" AND OrderStatus != "completed" AND OrderStatus != "failed"`, customerID)

	iter := c.ListWorkflow(context.Background(), &workflowservice.ListWorkflowExecutionsRequest{
		Namespace: "production",
		Query:     query,
		PageSize:  100,
	})

	var results []*workflow.WorkflowExecutionInfo
	for iter.HasNext() {
		exec, err := iter.Next()
		if err != nil {
			return nil, err
		}
		results = append(results, exec)
	}
	return results, nil
}
```

### Junior -> FAANG: Making Workflows Operationally Visible

The prerequisite gap: most engineers think of workflow visibility as a "nice to have" for dashboards. In production, visibility is how operations teams answer questions like "how many orders are stuck in approval?" and "which workflows for customer X are still running?" Without search attributes, those questions require iterating all running workflows and querying each one individually, which is slow and expensive.

The concrete workflow: register search attribute names in the namespace before using them (via `tctl` or the Temporal Cloud UI), then call `UpsertSearchAttributes` inside the workflow at each state transition. The search attributes are immediately queryable through the Temporal Web UI or the List API.

Know the type system for search attributes before your interview: `Keyword` is an exact-match string (use for IDs, status codes), `Text` is a full-text searchable string (use for free-form fields), `Int` is a 64-bit integer (use for monetary values in cents), `Double` is a float, `Bool` is a boolean, and `Datetime` is a timestamp. Choosing the wrong type (e.g., `Text` for a status field you want to filter by exact match) causes the visibility query to behave unexpectedly.

First-job habit: add search attributes for customer ID and workflow status to every workflow from day one. These two attributes answer 80% of operations questions. Adding them later requires deploying a code change to running workflows, which is a `GetVersion` operation.

### Senior @ FAANG: Visibility Query Design, Elasticsearch Limits, and Retention Policy

**Elasticsearch as the visibility backend.** For advanced visibility queries (arbitrary field combinations, range queries, sorting), Temporal requires an Elasticsearch cluster as the visibility backend. The standard visibility backend (Cassandra or Postgres) only supports filtering on a limited set of built-in fields. Temporal Cloud includes Elasticsearch-backed visibility by default. Self-hosted deployments that do not configure Elasticsearch can only filter by workflow ID, run ID, workflow type, status, and start time. Plan the Elasticsearch requirement before designing search attribute-heavy workflows.

**Search attribute cardinality and Elasticsearch performance.** High-cardinality `Keyword` fields (workflow ID, customer ID) are indexed as exact-match terms in Elasticsearch. This is efficient for equality queries but expensive for full-text searches. `Text` fields are tokenized and expensive for exact-match queries. Design search attribute types to match query patterns. If a field will be used for equality filters, use `Keyword`. If it will be used for free-text search, use `Text`. Avoid using `Text` for IDs or status values.

**Retention policy as a visibility and cost lever.** Temporal's namespace retention policy determines how long completed workflow history and visibility records are kept. The default retention is 72 hours. Extending it to 30 days allows querying completed workflows for post-incident investigations. But longer retention increases Elasticsearch storage costs and Cassandra/Postgres storage costs proportionally. Set retention based on the actual operational need: 7 days for high-volume workflows with short business cycles, 30-90 days for workflows with compliance or audit requirements. Visibility records and history records share the same retention policy within a namespace, so teams with mixed requirements should use separate namespaces.

**Using visibility queries for operational automation.** Beyond dashboards, visibility queries power operational automation. A daily job can query for all workflows in "pending_approval" status for more than 5 days and send escalation alerts. A deployment script can query for all running workflows on the old worker Build ID before confirming that drain is complete. A customer support tool can list all active workflows for a customer ID within seconds. These use cases justify the investment in consistent search attribute design across all workflows in a platform.

**Search attribute governance at the namespace level.** Search attributes are registered at the namespace level and shared across all workflows in that namespace. This means a team that registers `OrderStatus` as a `Keyword` constrains every other workflow that might want to use the same name. Establish a naming convention (prefix with workflow type: `Order_Status`, `Payment_Status`) and a registration process (PR to a shared attributes registry, reviewed by the platform team) before multiple teams start registering attributes. Attribute name collisions are one of the most common multi-team Temporal governance problems.

---
