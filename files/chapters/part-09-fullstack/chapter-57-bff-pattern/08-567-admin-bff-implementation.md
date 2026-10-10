## 57.7 Admin BFF Implementation

The admin BFF differs from the web and mobile BFFs in two important ways. First, it enforces stricter authorization: every request must come from an authenticated user with the `admin` role. Second, it returns sensitive operational data (customer email addresses, revenue figures, inventory levels, system alerts) that must never appear in the public-facing BFFs. This separation of concerns is a key security benefit of the BFF pattern: the admin BFF can expose PII and financial data without risk of accidentally leaking it through the mobile or web BFF.

The dashboard handler below checks the user's role before delegating to the aggregator. The response types include fields like `CustomerEmail` and `TotalRevenueCents` that exist nowhere in the web or mobile BFF response structs.

```go
// services/admin-bff/internal/handler/dashboard.go
package handler

import (
    "encoding/json"
    "net/http"
)

type DashboardHandler struct {
    aggregator *aggregator.DashboardAggregator
}

// AdminDashboardResponse includes sensitive data only admins should see
type AdminDashboardResponse struct {
    Stats      *DashboardStats   `json:"stats"`
    RecentOrders []*AdminOrder   `json:"recent_orders"`
    LowStock   []*LowStockItem   `json:"low_stock"`
    Revenue    *RevenueData      `json:"revenue"`
    Alerts     []*SystemAlert    `json:"alerts"`
}

type DashboardStats struct {
    TotalOrders     int     `json:"total_orders"`
    TotalRevenueCents int64 `json:"total_revenue_cents"`
    AverageOrderCents int64 `json:"average_order_cents"`
    TotalCustomers  int     `json:"total_customers"`
    NewCustomers    int     `json:"new_customers"`
    ConversionRate  float64 `json:"conversion_rate"`
    PendingOrders   int     `json:"pending_orders"`
    LowStockCount   int     `json:"low_stock_count"`
}

type AdminOrder struct {
    ID           string  `json:"id"`
    CustomerName string  `json:"customer_name"`
    CustomerEmail string `json:"customer_email"`
    TotalCents   int64  `json:"total_cents"`
    Status       string  `json:"status"`
    ItemCount    int     `json:"item_count"`
    CreatedAt    string  `json:"created_at"`
}

type LowStockItem struct {
    ProductID   string `json:"product_id"`
    ProductName string `json:"product_name"`
    CurrentStock int   `json:"current_stock"`
    ReorderLevel int   `json:"reorder_level"`
    Supplier    string `json:"supplier"`
}

type RevenueData struct {
    TodayCents     int64   `json:"today_cents"`
    ThisWeekCents  int64   `json:"this_week_cents"`
    ThisMonthCents int64   `json:"this_month_cents"`
    DailyCents     []int64 `json:"daily_cents"` // Last 30 days
}

type SystemAlert struct {
    ID       string `json:"id"`
    Type     string `json:"type"` // "warning", "error", "info"
    Message  string `json:"message"`
    Time     string `json:"time"`
}

func (h *DashboardHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Verify admin role
    user := auth.UserFromContext(ctx)
    if user == nil || user.Role != "admin" {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    dashboard, err := h.aggregator.GetDashboard(ctx)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(dashboard)
}
```

The dashboard aggregator fans out to four downstream services (analytics, orders, products, and alerts) then enriches the order data with customer names and emails from the user service. This enrichment step is a common BFF pattern: the order service stores only `CustomerID`, but the admin UI needs to display the customer's name and email inline. The BFF resolves these references by batch-fetching the relevant user records and joining them in memory.

```go
// services/admin-bff/internal/aggregator/dashboard.go
package aggregator

import (
    "context"
    "log/slog"
    "sync"
    "time"
)

type DashboardAggregator struct {
    orderClient     *serviceclient.OrderClient
    productClient   *serviceclient.ProductClient
    analyticsClient *serviceclient.AnalyticsClient
    alertClient     *serviceclient.AlertClient
}

func (a *DashboardAggregator) GetDashboard(ctx context.Context) (*AdminDashboardResponse, error) {
    var wg sync.WaitGroup
    var mu sync.Mutex
    resp := &AdminDashboardResponse{}
    var errs []error

    // Parallel aggregation from multiple services

    wg.Add(1)
    go func() {
        defer wg.Done()
        stats, err := a.getStats(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.Stats = stats
        }
        mu.Unlock()
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        orders, err := a.getRecentOrders(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.RecentOrders = orders
        }
        mu.Unlock()
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        lowStock, err := a.getLowStockItems(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.LowStock = lowStock
        }
        mu.Unlock()
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        revenue, err := a.getRevenueData(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.Revenue = revenue
        }
        mu.Unlock()
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        alerts, err := a.getAlerts(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.Alerts = alerts
        }
        mu.Unlock()
    }()

    wg.Wait()

    if len(errs) > 0 {
        slog.Warn("dashboard aggregation partial failures", "errors", errs)
    }

    return resp, nil
}

func (a *DashboardAggregator) getStats(ctx context.Context) (*DashboardStats, error) {
    // Get stats from analytics service
    now := time.Now()
    startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

    stats, err := a.analyticsClient.GetStats(ctx, startOfDay, now)
    if err != nil {
        return nil, err
    }

    // Get pending orders count
    pendingCount, err := a.orderClient.CountByStatus(ctx, "pending")
    if err != nil {
        pendingCount = 0 // Non-critical, continue
    }

    // Get low stock count
    lowStockCount, err := a.productClient.CountLowStock(ctx)
    if err != nil {
        lowStockCount = 0
    }

    return &DashboardStats{
        TotalOrders:    stats.OrderCount,
        TotalRevenueCents: stats.RevenueCents,
        AverageOrderCents: stats.RevenueCents / int64(stats.OrderCount),
        TotalCustomers: stats.CustomerCount,
        NewCustomers:   stats.NewCustomerCount,
        ConversionRate: stats.ConversionRate,
        PendingOrders:  pendingCount,
        LowStockCount:  lowStockCount,
    }, nil
}

func (a *DashboardAggregator) getRecentOrders(ctx context.Context) ([]*AdminOrder, error) {
    orders, err := a.orderClient.ListRecent(ctx, 10)
    if err != nil {
        return nil, err
    }

    // Need to enrich with customer data
    customerIDs := make([]string, len(orders))
    for i, o := range orders {
        customerIDs[i] = o.CustomerID
    }

    customers, _ := a.userClient.GetByIDs(ctx, customerIDs)
    customerMap := make(map[string]*serviceclient.User)
    for _, c := range customers {
        customerMap[c.ID] = c
    }

    result := make([]*AdminOrder, len(orders))
    for i, o := range orders {
        customer := customerMap[o.CustomerID]
        result[i] = &AdminOrder{
            ID:           o.ID,
            CustomerName: customer.Name,
            CustomerEmail: customer.Email,
            TotalCents:   o.TotalCents,
            Status:       o.Status,
            ItemCount:    len(o.Items),
            CreatedAt:    o.CreatedAt.Format(time.RFC3339),
        }
    }

    return result, nil
}
```

### Junior -> FAANG: Security as a First-Class Concern in Admin BFFs

The admin BFF is the highest-value target in your API surface. It exposes PII, financial data, and operational controls. The role check at the handler level shown above is necessary but not sufficient. Internalize the defense-in-depth model: check authorization at the handler, at the aggregator, and at the downstream service. Three layers of checking is not redundant. If any one layer has a bug, the other two contain the damage.

Common first-job mistakes in admin BFF security: relying solely on JWT role claims without verifying the claim against a database. A JWT with `"role": "admin"` is only trustworthy if the signing key is secure and the token has not been tampered with. If your admin BFF caches role information in memory and does not re-validate against the user service periodically, a deprovisioned admin can continue to access the BFF until their token expires. Production admin BFFs either use short-lived tokens (15 minutes) with frequent re-validation or check the user's current role on every request via the user service.

Another mistake is returning response types that include PII fields in your public-facing BFF response types. Go's type system helps here: if `AdminOrder` (which has `CustomerEmail`) and `WebOrder` (which does not) are separate structs in separate packages, you cannot accidentally serialize the admin struct in the web handler. Keep them separate.

For interviews: if asked "how do you ensure the admin API does not leak data to regular users," describe the role check at the handler layer, the separate struct types with PII fields, and the short-lived token re-validation policy.

### Senior @ FAANG: RBAC at the BFF and Audit Compliance

At senior level the admin BFF is where RBAC governance, audit logging, and compliance requirements intersect. These are not implementation details. They are requirements that shape the entire admin BFF architecture.

RBAC in the admin BFF should not be a single `"admin"` role check. Production admin panels have multiple role tiers: viewer (read-only access to orders and customers), operator (can process refunds and update order status), manager (can access revenue data and run bulk operations), super-admin (can access system configuration and user management). Each handler must check the specific permission required, not just the role name. A `role == "admin"` check grants super-admin access to every viewer in the admin panel, which violates least-privilege.

Implement permission checking as a middleware that reads permissions from a central policy service or from a set of JWT claims that encode specific permission scopes. Every handler declares its required scope: `RequirePermission("orders:read")`, `RequirePermission("revenue:read")`. The middleware enforces it. This pattern makes permissions auditable: you can grep the codebase for all permission checks and produce a permissions matrix for the compliance team.

Audit logging in the admin BFF is not optional if your company processes payment card data (PCI DSS), health records (HIPAA), or EU personal data (GDPR). Every request to the admin BFF that reads PII or modifies any record must produce an audit log entry containing: timestamp, authenticated user ID, user role, action performed, resource accessed, and source IP. This log must be written to an append-only store (not the same database as application data) and retained for the compliance-required period (typically 7 years for financial data).

At staff level, the admin BFF is also the service where data access patterns need the most scrutiny. Bulk export endpoints (download all orders as CSV, download all customer records) can be used to exfiltrate data. Rate limit these endpoints aggressively, require an additional confirmation step for large exports, log every export with the initiating user's identity, and alert the security team for exports above a threshold row count.

---
