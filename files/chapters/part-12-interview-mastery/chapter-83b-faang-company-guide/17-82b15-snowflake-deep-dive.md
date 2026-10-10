## 83B.15 Snowflake Deep Dive

### Overview for Go Engineers

Snowflake is the cloud data warehouse company that went public in the largest software IPO in history. Their core product is a SQL query engine that separates storage from compute, enabling elastic scaling of query capacity independent of storage costs. Go is used extensively in Snowflake's internal tooling, data plane services, and platform infrastructure. Snowflake's engineering problems are centered on query optimization, virtual warehouse management, distributed query execution, time-travel (historical data versioning), and data sharing across organizations. Engineers at Snowflake work on problems that blend database internals with distributed systems - query parsing, columnar storage, vectorized execution, and cloud-agnostic compute scaling. The interview process emphasizes SQL, database internals, and large-scale distributed systems - not just algorithms. If you cannot discuss B-trees, columnar storage, query plans, or distributed join algorithms, you will struggle in Snowflake interviews. Go engineers are expected to understand both the application layer and the systems that run underneath it.

### Interview Process

Snowflake's loop reflects its database DNA: expect depth on storage, query processing, and distributed state:

```
┌──────────────────────────────────────────────────────────────────┐
│                 SNOWFLAKE INTERVIEW PIPELINE                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │                                                          │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - Coding + SQL/database concepts                        │
│       ▼                                                          │
│  Virtual Onsite (5 rounds, 60 min each)                          │
│       │  - 2 Coding rounds (algorithms, data processing)         │
│       │  - 1 System Design round (data systems focus)            │
│       │  - 1 Database Internals round                            │
│       │  - 1 Behavioral round                                    │
│       ▼                                                          │
│  Debrief & Offer                                                 │
│  Timeline: 3-5 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

The Database Internals round is unique to Snowflake. It covers B-tree vs. LSM-tree trade-offs, columnar vs. row storage, query execution plans, predicate pushdown, and how Snowflake's virtual warehouses scale. You do not need to implement a database, but you must be able to discuss these topics fluently. Prepare by reading Snowflake's original VLDB paper ("The Snowflake Elastic Data Warehouse").

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| SWE | Software Engineer | 0-3 | $165K-$200K | $250K-$400K | Coding + database fundamentals |
| Senior SWE | Senior Engineer | 3-7 | $200K-$250K | $400K-$600K | System design + database internals |
| Staff SWE | Staff Engineer | 7-12 | $250K-$320K | $600K-$850K | Architecture + cross-system impact |
| Principal | Principal Engineer | 12+ | $310K-$390K | $850K-$1.2M+ | Query engine + platform strategy |

### Representative Interview Problems

#### Problem 1: Query Result Cache (Easy)

*Implement an LRU query result cache - fundamental to Snowflake's performance layer.*

```go
package main

import (
	"container/list"
	"fmt"
)

type QueryCache struct {
	capacity int
	cache    map[string]*list.Element
	lru      *list.List
}

type cacheEntry struct {
	key   string
	value [][]string // query result rows
}

func NewQueryCache(capacity int) *QueryCache {
	return &QueryCache{
		capacity: capacity,
		cache:    make(map[string]*list.Element),
		lru:      list.New(),
	}
}

func (qc *QueryCache) Get(query string) ([][]string, bool) {
	el, ok := qc.cache[query]
	if !ok {
		return nil, false
	}
	qc.lru.MoveToFront(el)
	return el.Value.(*cacheEntry).value, true
}

func (qc *QueryCache) Put(query string, result [][]string) {
	if el, ok := qc.cache[query]; ok {
		qc.lru.MoveToFront(el)
		el.Value.(*cacheEntry).value = result
		return
	}
	if qc.lru.Len() >= qc.capacity {
		evict := qc.lru.Back()
		if evict != nil {
			qc.lru.Remove(evict)
			delete(qc.cache, evict.Value.(*cacheEntry).key)
		}
	}
	el := qc.lru.PushFront(&cacheEntry{query, result})
	qc.cache[query] = el
}

func main() {
	cache := NewQueryCache(3)

	queries := []struct {
		q, result string
	}{
		{"SELECT * FROM orders WHERE date='2026-01'", "1000 rows"},
		{"SELECT COUNT(*) FROM users", "500000"},
		{"SELECT * FROM products WHERE active=true", "250 rows"},
	}

	for _, q := range queries {
		cache.Put(q.q, [][]string{{q.result}})
	}

	// Cache hit
	if result, ok := cache.Get("SELECT COUNT(*) FROM users"); ok {
		fmt.Printf("Cache hit: %v\n", result)
	}

	// Add 4th query - evicts LRU
	cache.Put("SELECT SUM(revenue) FROM sales", [][]string{{"$1.2B"}})

	// First query should be evicted
	if _, ok := cache.Get("SELECT * FROM orders WHERE date='2026-01'"); !ok {
		fmt.Println("LRU eviction: orders query removed from cache")
	}
}
```

#### Problem 2: Columnar Storage Reader (Easy)

*Read and filter data from a simulated columnar storage format - core to Snowflake's performance.*

```go
package main

import "fmt"

// ColumnarTable stores data in column-major format for efficient scans.
type ColumnarTable struct {
	columns map[string][]any
	rowCount int
}

func NewColumnarTable() *ColumnarTable {
	return &ColumnarTable{columns: make(map[string][]any)}
}

func (ct *ColumnarTable) AddColumn(name string, data []any) {
	ct.columns[name] = data
	ct.rowCount = max(ct.rowCount, len(data))
}

// Scan returns rows matching a predicate, reading only specified columns.
// This simulates columnar projection + predicate pushdown.
func (ct *ColumnarTable) Scan(projectCols []string, predicate func(row map[string]any) bool) []map[string]any {
	var results []map[string]any
	for i := range ct.rowCount {
		row := make(map[string]any)
		// Read all columns for predicate evaluation
		for col, data := range ct.columns {
			if i < len(data) {
				row[col] = data[i]
			}
		}
		if predicate(row) {
			// Project only requested columns
			projected := make(map[string]any, len(projectCols))
			for _, col := range projectCols {
				projected[col] = row[col]
			}
			results = append(results, projected)
		}
	}
	return results
}

func main() {
	table := NewColumnarTable()
	table.AddColumn("order_id", []any{1, 2, 3, 4, 5})
	table.AddColumn("customer", []any{"Alice", "Bob", "Alice", "Carol", "Alice"})
	table.AddColumn("amount", []any{100.0, 250.0, 75.0, 320.0, 200.0})
	table.AddColumn("status", []any{"completed", "pending", "completed", "completed", "canceled"})

	// SELECT order_id, amount FROM orders WHERE customer='Alice' AND status='completed'
	results := table.Scan([]string{"order_id", "amount"}, func(row map[string]any) bool {
		return row["customer"] == "Alice" && row["status"] == "completed"
	})

	fmt.Println("Query results (order_id, amount for Alice's completed orders):")
	for _, r := range results {
		fmt.Printf("  order_id=%v amount=$%.2f\n", r["order_id"], r["amount"])
	}
}
```

#### Problem 3: Virtual Warehouse Auto-Scaler (Easy)

*Simulate Snowflake's auto-scaling logic that adds/removes compute nodes based on query queue depth.*

```go
package main

import (
	"fmt"
	"time"
)

type Warehouse struct {
	Name      string
	Size      int // number of compute nodes (1, 2, 4, 8, 16...)
	MaxSize   int
	MinSize   int
}

type ScalingDecision struct {
	Action     string // "scale_out", "scale_in", "no_change"
	NewSize    int
	Reason     string
}

// AutoScale determines whether to scale out or in based on queue depth and utilization.
func AutoScale(wh Warehouse, queueDepth int, avgUtilizationPct float64) ScalingDecision {
	// Scale out: high queue or high utilization
	if (queueDepth > 5 || avgUtilizationPct > 80) && wh.Size < wh.MaxSize {
		newSize := min(wh.Size*2, wh.MaxSize)
		return ScalingDecision{
			Action:  "scale_out",
			NewSize: newSize,
			Reason:  fmt.Sprintf("queue=%d utilization=%.0f%%", queueDepth, avgUtilizationPct),
		}
	}
	// Scale in: low queue and low utilization for sustained period
	if queueDepth == 0 && avgUtilizationPct < 20 && wh.Size > wh.MinSize {
		newSize := max(wh.Size/2, wh.MinSize)
		return ScalingDecision{
			Action:  "scale_in",
			NewSize: newSize,
			Reason:  fmt.Sprintf("queue=%d utilization=%.0f%% (idle)", queueDepth, avgUtilizationPct),
		}
	}
	return ScalingDecision{Action: "no_change", NewSize: wh.Size}
}

func main() {
	wh := Warehouse{Name: "COMPUTE_WH_M", Size: 2, MaxSize: 16, MinSize: 1}

	scenarios := []struct {
		queue int
		util  float64
		label string
	}{
		{12, 90, "peak load"},
		{1, 50, "moderate"},
		{0, 8, "idle"},
	}

	for _, s := range scenarios {
		decision := AutoScale(wh, s.queue, s.util)
		fmt.Printf("[%-12s] action=%-10s size %d→%d reason=%s\n",
			s.label, decision.Action, wh.Size, decision.NewSize, decision.Reason)
		if decision.Action != "no_change" {
			wh.Size = decision.NewSize
		}
		time.Sleep(0) // simulate time passing
	}
}
```

#### Problem 4: Time-Travel Query Executor (Medium)

*Implement Snowflake's time-travel feature - query data as it existed at a specific point in the past.*

```go
package main

import (
	"cmp"
	"fmt"
	"slices"
	"time"
)

type RowVersion struct {
	RowID     string
	Data      map[string]any
	ValidFrom time.Time
	ValidTo   time.Time // zero = current
	Deleted   bool
}

type TimeTravelTable struct {
	versions []RowVersion
}

// Insert adds or updates a row, creating a new version.
func (t *TimeTravelTable) Insert(rowID string, data map[string]any, at time.Time) {
	// Expire current version
	for i, v := range t.versions {
		if v.RowID == rowID && v.ValidTo.IsZero() {
			t.versions[i].ValidTo = at
		}
	}
	t.versions = append(t.versions, RowVersion{
		RowID:     rowID,
		Data:      data,
		ValidFrom: at,
	})
}

// Delete marks a row as deleted at the given time.
func (t *TimeTravelTable) Delete(rowID string, at time.Time) {
	for i, v := range t.versions {
		if v.RowID == rowID && v.ValidTo.IsZero() {
			t.versions[i].ValidTo = at
			t.versions[i].Deleted = true
		}
	}
}

// QueryAt returns all non-deleted rows valid at the given timestamp.
func (t *TimeTravelTable) QueryAt(at time.Time) []RowVersion {
	var result []RowVersion
	for _, v := range t.versions {
		if v.Deleted {
			continue
		}
		validAfterStart := !v.ValidFrom.After(at)
		validBeforeEnd := v.ValidTo.IsZero() || v.ValidTo.After(at)
		if validAfterStart && validBeforeEnd {
			result = append(result, v)
		}
	}
	slices.SortFunc(result, func(a, b RowVersion) int {
		return cmp.Compare(a.RowID, b.RowID)
		// simple sort for demo - production uses rowID collation
	})
	return result
}

func main() {
	table := &TimeTravelTable{}
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 := t0.Add(24 * time.Hour)
	t2 := t1.Add(24 * time.Hour)

	table.Insert("row1", map[string]any{"name": "Alice", "balance": 1000}, t0)
	table.Insert("row2", map[string]any{"name": "Bob", "balance": 500}, t0)
	table.Insert("row1", map[string]any{"name": "Alice", "balance": 1500}, t1) // update
	table.Delete("row2", t2)                                                     // delete Bob

	fmt.Println("Current state (now):")
	for _, r := range table.QueryAt(t2.Add(time.Hour)) {
		fmt.Printf("  %s: %v\n", r.RowID, r.Data)
	}

	fmt.Println("\nTime-travel: state at t1 (before Bob deleted):")
	for _, r := range table.QueryAt(t1.Add(time.Hour)) {
		fmt.Printf("  %s: %v\n", r.RowID, r.Data)
	}

	fmt.Println("\nTime-travel: original state at t0:")
	for _, r := range table.QueryAt(t0.Add(time.Hour)) {
		fmt.Printf("  %s: %v\n", r.RowID, r.Data)
	}
}
```

#### Problem 5: Distributed Hash Join (Medium)

*Implement a partitioned hash join - core algorithm in Snowflake's distributed query execution engine.*

```go
package main

import "fmt"

type Row struct {
	Key   int
	Value string
}

// HashJoin performs an inner join of left and right relations on the key column.
// Uses build+probe phases as in distributed query execution.
func HashJoin(left, right []Row) []struct{ Left, Right Row } {
	// Build phase: hash the smaller (left) table
	build := make(map[int][]Row)
	for _, r := range left {
		build[r.Key] = append(build[r.Key], r)
	}

	// Probe phase: scan right table and look up matches
	var results []struct{ Left, Right Row }
	for _, r := range right {
		for _, l := range build[r.Key] {
			results = append(results, struct{ Left, Right Row }{l, r})
		}
	}
	return results
}

// PartitionedHashJoin simulates distributed hash join across N partitions.
func PartitionedHashJoin(left, right []Row, partitions int) []struct{ Left, Right Row } {
	// Partition both sides by hash(key) % partitions
	leftParts := make([][]Row, partitions)
	rightParts := make([][]Row, partitions)
	for i := range partitions {
		leftParts[i] = []Row{}
		rightParts[i] = []Row{}
	}
	for _, r := range left {
		p := r.Key % partitions
		leftParts[p] = append(leftParts[p], r)
	}
	for _, r := range right {
		p := r.Key % partitions
		rightParts[p] = append(rightParts[p], r)
	}

	// Each partition can be joined independently (parallelizable)
	var results []struct{ Left, Right Row }
	for i := range partitions {
		partResults := HashJoin(leftParts[i], rightParts[i])
		results = append(results, partResults...)
	}
	return results
}

func main() {
	customers := []Row{
		{1, "Alice"}, {2, "Bob"}, {3, "Carol"}, {4, "Dave"},
	}
	orders := []Row{
		{1, "Order-A"}, {1, "Order-B"}, {3, "Order-C"}, {5, "Order-D"},
	}

	results := PartitionedHashJoin(customers, orders, 3)
	fmt.Println("Join results (customer → order):")
	for _, r := range results {
		fmt.Printf("  Customer %s → %s\n", r.Left.Value, r.Right.Value)
	}
}
```

#### Problem 6: Query Plan Optimizer - Predicate Pushdown (Medium)

*Implement predicate pushdown optimization that moves filters earlier in the query execution plan.*

```go
package main

import "fmt"

type NodeType int

const (
	Scan   NodeType = iota
	Filter
	Join
	Project
	Aggregate
)

func (n NodeType) String() string {
	return [...]string{"Scan", "Filter", "Join", "Project", "Aggregate"}[n]
}

type PlanNode struct {
	Type      NodeType
	Table     string
	Predicate string
	Children  []*PlanNode
}

func (p *PlanNode) Print(indent string) {
	pred := ""
	if p.Predicate != "" {
		pred = " [" + p.Predicate + "]"
	}
	table := ""
	if p.Table != "" {
		table = " " + p.Table
	}
	fmt.Printf("%s%s%s%s\n", indent, p.Type, table, pred)
	for _, child := range p.Children {
		child.Print(indent + "  ")
	}
}

// PushDownPredicates moves Filter nodes as close to their Scan nodes as possible.
func PushDownPredicates(node *PlanNode) *PlanNode {
	if node == nil {
		return nil
	}
	// Recursively optimize children
	for i, child := range node.Children {
		node.Children[i] = PushDownPredicates(child)
	}
	// If this is a Filter above a Join, push to the appropriate scan
	if node.Type == Filter && len(node.Children) == 1 && node.Children[0].Type == Join {
		join := node.Children[0]
		// Simplified: push filter to left child (in production, analyze predicate tables)
		pushedFilter := &PlanNode{Type: Filter, Predicate: node.Predicate, Children: []*PlanNode{join.Children[0]}}
		join.Children[0] = pushedFilter
		return join // remove Filter from above Join
	}
	return node
}

func main() {
	// Original plan: Filter(Join(Scan(orders), Scan(customers)))
	original := &PlanNode{
		Type:      Filter,
		Predicate: "status='completed'",
		Children: []*PlanNode{
			{
				Type: Join,
				Children: []*PlanNode{
					{Type: Scan, Table: "orders"},
					{Type: Scan, Table: "customers"},
				},
			},
		},
	}

	fmt.Println("Original plan:")
	original.Print("  ")

	optimized := PushDownPredicates(original)
	fmt.Println("\nOptimized plan (predicate pushed down):")
	optimized.Print("  ")
}
```

#### Problem 7: Data Sharing - Cross-Account Access Control (Medium)

*Implement Snowflake's data sharing model where one account shares objects with another with row-level security.*

```go
package main

import (
	"errors"
	"fmt"
)

type Share struct {
	ID          string
	OwnerAcct   string
	ConsumerAccts map[string]bool
	Objects     []string // database.schema.table
	RowFilter   func(table string, row map[string]any, consumerAcct string) bool
}

type DataShareRegistry struct {
	shares map[string]*Share
}

func NewDataShareRegistry() *DataShareRegistry {
	return &DataShareRegistry{shares: make(map[string]*Share)}
}

func (r *DataShareRegistry) CreateShare(share *Share) {
	r.shares[share.ID] = share
}

func (r *DataShareRegistry) QuerySharedTable(
	shareID, consumerAcct, table string,
	rows []map[string]any,
) ([]map[string]any, error) {
	share, ok := r.shares[shareID]
	if !ok {
		return nil, fmt.Errorf("share %q not found", shareID)
	}
	if !share.ConsumerAccts[consumerAcct] {
		return nil, errors.New("access denied: account not in share consumers")
	}
	tableAllowed := false
	for _, obj := range share.Objects {
		if obj == table {
			tableAllowed = true
		}
	}
	if !tableAllowed {
		return nil, fmt.Errorf("table %q not included in share", table)
	}

	var result []map[string]any
	for _, row := range rows {
		if share.RowFilter == nil || share.RowFilter(table, row, consumerAcct) {
			result = append(result, row)
		}
	}
	return result, nil
}

func main() {
	registry := NewDataShareRegistry()

	// Company A shares sales data with Company B, filtered to public data only
	registry.CreateShare(&Share{
		ID:            "share_sales_pub",
		OwnerAcct:     "company_a",
		ConsumerAccts: map[string]bool{"company_b": true},
		Objects:       []string{"prod_db.public.sales"},
		RowFilter: func(table string, row map[string]any, consumer string) bool {
			// Only expose non-PII rows
			return row["is_public"] == true
		},
	})

	salesRows := []map[string]any{
		{"order_id": 1, "amount": 100.0, "is_public": true},
		{"order_id": 2, "amount": 500.0, "is_public": false}, // internal
		{"order_id": 3, "amount": 75.0, "is_public": true},
	}

	rows, err := registry.QuerySharedTable("share_sales_pub", "company_b", "prod_db.public.sales", salesRows)
	fmt.Printf("Company B sees %d rows (err=%v)\n", len(rows), err)

	_, err = registry.QuerySharedTable("share_sales_pub", "company_c", "prod_db.public.sales", salesRows)
	fmt.Printf("Company C access: %v\n", err)
}
```

#### Problem 8: Micro-Partition Statistics for Query Pruning (Hard)

*Implement Snowflake's micro-partition metadata that enables partition pruning - skipping irrelevant data blocks.*

```go
package main

import (
	"fmt"
	"math"
)

type MicroPartition struct {
	ID       int
	RowCount int
	MinValues map[string]float64
	MaxValues map[string]float64
	NullCounts map[string]int
}

type PartitionPruner struct {
	partitions []MicroPartition
}

func NewPartitionPruner(partitions []MicroPartition) *PartitionPruner {
	return &PartitionPruner{partitions: partitions}
}

type Predicate struct {
	Column string
	Op     string  // "=", ">", "<", ">=", "<=", "between"
	LowVal float64
	HighVal float64 // used for "between"
}

// CanPrune returns true if the partition can be safely skipped.
func (pp *PartitionPruner) CanPrune(p MicroPartition, pred Predicate) bool {
	min := p.MinValues[pred.Column]
	max := p.MaxValues[pred.Column]

	switch pred.Op {
	case "=":
		return pred.LowVal < min || pred.LowVal > max
	case ">":
		return max <= pred.LowVal
	case ">=":
		return max < pred.LowVal
	case "<":
		return min >= pred.LowVal
	case "<=":
		return min > pred.LowVal
	case "between":
		return max < pred.LowVal || min > pred.HighVal
	}
	return false
}

// PrunePartitions returns only partitions that might contain matching rows.
func (pp *PartitionPruner) PrunePartitions(pred Predicate) (retained, pruned []int) {
	for _, p := range pp.partitions {
		if pp.CanPrune(p, pred) {
			pruned = append(pruned, p.ID)
		} else {
			retained = append(retained, p.ID)
		}
	}
	return retained, pruned
}

func main() {
	partitions := []MicroPartition{
		{ID: 1, RowCount: 1000, MinValues: map[string]float64{"order_date": 20240101}, MaxValues: map[string]float64{"order_date": 20240331}},
		{ID: 2, RowCount: 1000, MinValues: map[string]float64{"order_date": 20240401}, MaxValues: map[string]float64{"order_date": 20240630}},
		{ID: 3, RowCount: 1000, MinValues: map[string]float64{"order_date": 20240701}, MaxValues: map[string]float64{"order_date": 20240930}},
		{ID: 4, RowCount: 1000, MinValues: map[string]float64{"order_date": 20241001}, MaxValues: map[string]float64{"order_date": 20241231}},
	}

	pruner := NewPartitionPruner(partitions)

	// Query: WHERE order_date BETWEEN 20240401 AND 20240630
	pred := Predicate{Column: "order_date", Op: "between", LowVal: 20240401, HighVal: 20240630}
	retained, pruned := pruner.PrunePartitions(pred)

	totalRows := len(partitions) * 1000
	prunedRows := len(pruned) * 1000
	fmt.Printf("Query: order_date BETWEEN 20240401 AND 20240630\n")
	fmt.Printf("Retained partitions: %v (scan %d rows)\n", retained, len(retained)*1000)
	fmt.Printf("Pruned partitions:   %v (skipped %d rows)\n", pruned, prunedRows)
	fmt.Printf("Scan efficiency: %.0f%% reduction\n", float64(prunedRows)/float64(totalRows)*100)
	_ = math.MaxFloat64
}
```

#### Problem 9: Snowpipe - Continuous Data Ingestion (Hard)

*Build a Snowpipe-style micro-batch ingestion pipeline that continuously loads staged files into a table.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type StagedFile struct {
	Path      string
	SizeBytes int64
	StagedAt  time.Time
}

type IngestionRecord struct {
	File      StagedFile
	StartedAt time.Time
	EndedAt   time.Time
	RowsLoaded int
	Status    string
}

type Snowpipe struct {
	mu           sync.Mutex
	pending      []StagedFile
	history      []IngestionRecord
	batchSize    int
	batchInterval time.Duration
	stopCh       chan struct{}
}

func NewSnowpipe(batchSize int, batchInterval time.Duration) *Snowpipe {
	return &Snowpipe{
		batchSize:    batchSize,
		batchInterval: batchInterval,
		stopCh:       make(chan struct{}),
	}
}

func (sp *Snowpipe) Stage(file StagedFile) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	sp.pending = append(sp.pending, file)
}

func (sp *Snowpipe) processBatch() {
	sp.mu.Lock()
	if len(sp.pending) == 0 {
		sp.mu.Unlock()
		return
	}
	batch := sp.pending[:min(sp.batchSize, len(sp.pending))]
	sp.pending = sp.pending[len(batch):]
	sp.mu.Unlock()

	for _, file := range batch {
		start := time.Now()
		// Simulate load (in production: parse CSV/JSON, write to columnar storage)
		rows := int(file.SizeBytes / 100) // simulate ~100 bytes per row
		record := IngestionRecord{
			File:       file,
			StartedAt:  start,
			EndedAt:    time.Now(),
			RowsLoaded: rows,
			Status:     "loaded",
		}
		sp.mu.Lock()
		sp.history = append(sp.history, record)
		sp.mu.Unlock()
		fmt.Printf("  Loaded %s: %d rows\n", file.Path, rows)
	}
}

func (sp *Snowpipe) Start() {
	go func() {
		ticker := time.NewTicker(sp.batchInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				sp.processBatch()
			case <-sp.stopCh:
				return
			}
		}
	}()
}

func (sp *Snowpipe) Stop() { close(sp.stopCh) }

func (sp *Snowpipe) LoadHistory() []IngestionRecord {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return append([]IngestionRecord{}, sp.history...)
}

func main() {
	pipe := NewSnowpipe(5, 100*time.Millisecond)
	pipe.Start()

	// Stage files as they arrive
	for i := range 8 {
		pipe.Stage(StagedFile{
			Path:      fmt.Sprintf("s3://bucket/data/file_%02d.csv", i),
			SizeBytes: int64(1000 + i*500),
			StagedAt:  time.Now(),
		})
	}

	time.Sleep(400 * time.Millisecond) // let batches process
	pipe.Stop()

	history := pipe.LoadHistory()
	fmt.Printf("\nTotal files loaded: %d\n", len(history))
	totalRows := 0
	for _, r := range history {
		totalRows += r.RowsLoaded
	}
	fmt.Printf("Total rows ingested: %d\n", totalRows)
}
```

#### Problem 10: Query Cost Estimator (Hard)

*Estimate query execution cost using statistics - core to Snowflake's query optimizer choosing execution plans.*

```go
package main

import (
	"fmt"
	"math"
)

type TableStats struct {
	Name        string
	RowCount    int64
	SizeBytes   int64
	ColumnStats map[string]ColumnStats
}

type ColumnStats struct {
	DistinctValues int64
	NullFraction   float64
	MinVal, MaxVal float64
}

// SelectivityEstimate estimates the fraction of rows matching a predicate.
func SelectivityEstimate(stats ColumnStats, op string, value float64, totalRows int64) float64 {
	switch op {
	case "=":
		if stats.DistinctValues == 0 {
			return 0
		}
		return 1.0 / float64(stats.DistinctValues)
	case ">", "<":
		rng := stats.MaxVal - stats.MinVal
		if rng == 0 {
			return 0
		}
		sel := (value - stats.MinVal) / rng
		if op == ">" {
			sel = 1 - sel
		}
		return math.Max(0, math.Min(1, sel))
	case "between":
		// value is low - use MaxVal as high for demo
		return math.Max(0, math.Min(1, (stats.MaxVal-value)/(stats.MaxVal-stats.MinVal)))
	}
	return 1.0
}

type QueryPlan struct {
	TableName  string
	Predicates []struct {
		Column string
		Op     string
		Value  float64
	}
	JoinTable string
}

func EstimateQueryCost(plan QueryPlan, stats map[string]TableStats) {
	ts, ok := stats[plan.TableName]
	if !ok {
		fmt.Printf("No stats for table %s\n", plan.TableName)
		return
	}

	selectivity := 1.0
	for _, pred := range plan.Predicates {
		colStats := ts.ColumnStats[pred.Column]
		sel := SelectivityEstimate(colStats, pred.Op, pred.Value, ts.RowCount)
		selectivity *= sel
	}

	estimatedRows := int64(float64(ts.RowCount) * selectivity)
	estimatedBytes := int64(float64(ts.SizeBytes) * selectivity)

	fmt.Printf("Table: %s (%.0fM rows)\n", plan.TableName, float64(ts.RowCount)/1e6)
	fmt.Printf("Estimated rows after filter: %d (%.2f%% selectivity)\n", estimatedRows, selectivity*100)
	fmt.Printf("Estimated data scan: %.2f MB\n", float64(estimatedBytes)/1e6)

	if plan.JoinTable != "" {
		jts := stats[plan.JoinTable]
		joinCost := float64(estimatedRows) * math.Log2(float64(jts.RowCount)+1)
		fmt.Printf("Estimated join cost (rows×log N): %.0f\n", joinCost)
	}
}

func main() {
	stats := map[string]TableStats{
		"orders": {
			Name:      "orders",
			RowCount:  100_000_000,
			SizeBytes: 10_000_000_000,
			ColumnStats: map[string]ColumnStats{
				"status":     {DistinctValues: 5, MinVal: 0, MaxVal: 4},
				"order_date": {DistinctValues: 365, MinVal: 20240101, MaxVal: 20241231},
				"amount":     {DistinctValues: 50000, MinVal: 1, MaxVal: 10000},
			},
		},
	}

	plan := QueryPlan{
		TableName: "orders",
		Predicates: []struct {
			Column string
			Op     string
			Value  float64
		}{
			{"status", "=", 1},     // completed
			{"amount", ">", 1000},  // high value
		},
	}

	EstimateQueryCost(plan, stats)
}
```

---

### System Design Topics

**Top 5 Snowflake System Design Questions:**

1. **Design Snowflake's Query Execution Engine** - Execute SQL queries across thousands of distributed compute nodes. Topics: query parsing/planning, physical operators (scan, filter, join, aggregate), task graph scheduling, vectorized execution, pipeline parallelism, shuffle/broadcast join strategies.

2. **Design the Virtual Warehouse Manager** - Auto-scale compute clusters on demand. Topics: query queue monitoring, multi-cluster warm pool, cold start latency, resource isolation between warehouses, billing by second granularity, idle auto-suspend.

3. **Design Snowflake Time-Travel & Fail-Safe** - Keep historical versions of data for 90 days (time-travel) + 7 days (fail-safe). Topics: copy-on-write storage with S3/Azure ADLS/GCS, micro-partition versioning, storage amplification cost management, retention policy enforcement.

4. **Design Snowflake Data Sharing** - Share live, governed data between accounts without copying. Topics: metadata sharing, row-level security policies, share revocation, consumer account access logging, cross-cloud/cross-region data sharing considerations.

5. **Design Snowpipe Continuous Ingestion** - Load data from cloud storage into Snowflake within seconds of file arrival. Topics: event-driven triggers (S3 notifications), micro-batch scheduling, deduplication, schema inference, error handling, backpressure.

---

### Behavioral Focus

Snowflake's culture centers on **"Customer Obsession," "Integrity," and "Executes with Excellence."** Behavioral themes:

- **Customer value:** "Tell me about a time an engineering decision you made directly improved a customer experience."
- **Technical excellence:** "Describe a complex performance optimization - what was the problem, how did you diagnose it, and what was the impact?"
- **Collaboration across functions:** "How have you worked with product and customer teams to shape the technical direction of a feature?"
- **Data-driven engineering:** "Describe a time you used data to challenge conventional wisdom in your system's design."
- **Operating at scale:** "Tell me about a system that needed to scale 100x - what changed architecturally?"

---

### Insider Tips

**Common Mistakes:**
- Not knowing database internals (B-trees, LSM-trees, columnar storage) - the Database Internals round will expose gaps quickly.
- Designing Snowflake-style systems with row-oriented storage when columnar is clearly better for the query patterns.
- Ignoring the separation of storage and compute - this is Snowflake's core architectural insight and should appear in your designs.
- Treating SQL query planning as a simple string-processing problem rather than a tree transformation problem.

**Strong Hire Signals:**
- Mentioning micro-partition pruning (zone maps) before being asked about performance.
- Discussing columnar compression (run-length encoding, delta encoding) in storage design.
- Proposing time-travel via copy-on-write (immutable partitions) without prompting.
- Understanding virtual warehouse multi-cluster and warm pool concepts.

**Red Flags:**
- Using row-oriented storage for analytical query workloads.
- Not discussing query optimization (predicate pushdown, join ordering) in query engine design.
- Proposing mutable storage for time-travel instead of immutable versioned micro-partitions.

---

### 8-Week Preparation Timeline

```
Week 1: Database Internals Foundations
  Mon-Tue: B-tree vs. LSM-tree, columnar vs. row storage, compression techniques
  Wed-Thu: Query execution plans, predicate pushdown, join algorithms
  Fri:     Read Snowflake VLDB paper (search: "Snowflake Elastic Data Warehouse 2016")
  Weekend: Implement LRU query cache and columnar scan in Go

Week 2: Distributed Query Processing
  Mon-Tue: Distributed hash join, sort-merge join, broadcast join
  Wed-Thu: Query cost estimation, cardinality estimation
  Fri:     Vectorized execution concepts, SIMD basics
  Weekend: Build a partitioned hash join and query plan optimizer

Week 3: Algorithms - Data Processing
  Mon-Fri: 2 problems/day - sorting algorithms, external sort, top-K, histogram
  Weekend: Implement Count-Min Sketch, HyperLogLog

Week 4: System Design - Data Warehouse Systems
  Mon-Tue: Design Snowflake query execution engine (whiteboard)
  Wed-Thu: Design virtual warehouse auto-scaler
  Fri:     Design time-travel storage system
  Weekend: Mock system design interview (data systems focus)

Week 5: Cloud Storage & Ingestion
  Mon-Tue: S3 event notifications, object storage patterns
  Wed-Thu: Micro-batch processing, exactly-once semantics
  Fri:     Schema evolution, Parquet format concepts
  Weekend: Design Snowpipe ingestion system

Week 6: Go for Data Systems
  Mon-Tue: io.Reader pipelines, streaming data processing
  Wed-Thu: Concurrent data processing, worker pools
  Fri:     Memory management, garbage collection for large datasets
  Weekend: Build mini Snowpipe in Go

Week 7: SQL & Advanced Database Topics
  Mon-Tue: Window functions, CTEs, lateral joins
  Wed-Thu: EXPLAIN plan analysis, index design
  Fri:     Row-level security, data governance concepts
  Weekend: SQL query optimization practice (5 complex queries)

Week 8: Final Prep
  Mon-Tue: Behavioral stories - customer impact, scale, performance
  Wed:     Full mock onsite (all 5 rounds)
  Thu:     Rest, logistics
  Fri:     Light review of Snowflake architecture blog posts
```

---


### Junior → FAANG: Snowflake Interview Preparation Basics

Snowflake engineering interviews reflect its core product: a cloud data warehouse built for massive-scale SQL analytics. Interview preparation should include deep knowledge of distributed query execution, columnar storage, data warehouse architecture, and cloud-native infrastructure patterns. Coding interviews are standard. System design interviews often involve data pipeline and analytics system design. Know Snowflake's architecture: virtual warehouses (compute), the storage layer (S3-based columnar format), and the services layer (metadata, query optimization, result caching).

### Senior @ FAANG: Snowflake Senior and Staff: Query Engine Depth and Multi-Cloud Architecture

At the senior and staff level, Snowflake's engineering bar includes depth in distributed query processing: how a SQL query is parsed, planned, optimized, and executed across a fleet of compute nodes, with intermediate results potentially spilling to disk or being exchanged over the network. Staff candidates should understand Snowflake's time-travel and data sharing features and the engineering challenges they introduce: point-in-time consistency for time travel requires micropartition immutability and a version history index. Secure data sharing across accounts requires access control at the storage level rather than the application level. Snowflake's multi-cloud architecture (AWS, Azure, GCP) also introduces interesting engineering constraints: the query engine must abstract over cloud-provider-specific storage and networking APIs while maintaining consistent performance across providers.

---
