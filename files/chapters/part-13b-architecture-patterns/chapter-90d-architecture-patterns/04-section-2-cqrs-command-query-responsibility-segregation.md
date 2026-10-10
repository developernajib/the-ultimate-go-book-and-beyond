## 90D.3 CQRS: Command Query Responsibility Segregation

CQRS separates the write model (commands that mutate state) from the read model (queries that return data), allowing each to be independently optimized. Commands go through a normalized write store that enforces business invariants, while queries read from a denormalized projection tailored for display. The real benefit appears at scale: reads can be served from an in-memory projection, a Redis cache, or an Elasticsearch index without touching the transactional database. When a command succeeds, it emits an event that updates the read model asynchronously, keeping both sides eventually consistent. The implementation below demonstrates a `ProductCommandHandler` writing to a normalized store and an `InMemoryReadStore` acting as a live projection updated by the same event bus.

```go
package cqrs

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ─── Commands ───

type Command interface {
	CommandName() string
}

type CreateProductCommand struct {
	Name        string
	Description string
	Price       int64
	Stock       int
}

func (c CreateProductCommand) CommandName() string { return "CreateProduct" }

type UpdateStockCommand struct {
	ProductID string
	Delta     int // positive = add, negative = remove
}

func (c UpdateStockCommand) CommandName() string { return "UpdateStock" }

// ─── Queries ───

type Query interface {
	QueryName() string
}

type GetProductQuery struct {
	ProductID string
}

func (q GetProductQuery) QueryName() string { return "GetProduct" }

type SearchProductsQuery struct {
	Name     string
	MaxPrice int64
	Page     int
	PageSize int
}

func (q SearchProductsQuery) QueryName() string { return "SearchProducts" }

// ─── Write Model (normalized for consistency) ───

type Product struct {
	ID          string
	Name        string
	Description string
	Price       int64
	Stock       int
	Version     int
	UpdatedAt   time.Time
}

// ProductCommandRepository handles writes
type ProductCommandRepository interface {
	Save(ctx context.Context, p *Product) error
	FindByID(ctx context.Context, id string) (*Product, error)
}

// ─── Read Model (denormalized for query performance) ───

type ProductReadModel struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Price       int64   `json:"price"`
	PriceFormatted string `json:"price_formatted"`
	Stock       int     `json:"stock"`
	InStock     bool    `json:"in_stock"`
	Category    string  `json:"category"`
}

// ProductQueryRepository handles reads from denormalized view
type ProductQueryRepository interface {
	FindByID(ctx context.Context, id string) (*ProductReadModel, error)
	Search(ctx context.Context, q SearchProductsQuery) ([]*ProductReadModel, int, error)
}

// ─── Command Handler ───

type CommandHandler interface {
	Handle(ctx context.Context, cmd Command) error
}

type ProductCommandHandler struct {
	repo        ProductCommandRepository
	eventBus    EventBus
	projections []Projection
}

type EventBus interface {
	Publish(ctx context.Context, event any) error
}

type Projection interface {
	Handle(ctx context.Context, event any) error
}

func (h *ProductCommandHandler) Handle(ctx context.Context, cmd Command) error {
	switch c := cmd.(type) {
	case CreateProductCommand:
		return h.handleCreate(ctx, c)
	case UpdateStockCommand:
		return h.handleUpdateStock(ctx, c)
	default:
		return fmt.Errorf("unknown command: %s", cmd.CommandName())
	}
}

func (h *ProductCommandHandler) handleCreate(ctx context.Context, cmd CreateProductCommand) error {
	product := &Product{
		ID:          generateID(),
		Name:        cmd.Name,
		Description: cmd.Description,
		Price:       cmd.Price,
		Stock:       cmd.Stock,
		Version:     1,
		UpdatedAt:   time.Now(),
	}

	if err := h.repo.Save(ctx, product); err != nil {
		return err
	}

	// Publish event to update read models
	event := ProductCreatedEvent{
		ProductID: product.ID,
		Name:      product.Name,
		Price:     product.Price,
		Stock:     product.Stock,
	}

	return h.eventBus.Publish(ctx, event)
}

func (h *ProductCommandHandler) handleUpdateStock(ctx context.Context, cmd UpdateStockCommand) error {
	product, err := h.repo.FindByID(ctx, cmd.ProductID)
	if err != nil {
		return err
	}

	newStock := product.Stock + cmd.Delta
	if newStock < 0 {
		return fmt.Errorf("insufficient stock: current=%d delta=%d", product.Stock, cmd.Delta)
	}

	product.Stock = newStock
	product.Version++
	product.UpdatedAt = time.Now()

	if err := h.repo.Save(ctx, product); err != nil {
		return err
	}

	return h.eventBus.Publish(ctx, StockUpdatedEvent{
		ProductID: cmd.ProductID,
		NewStock:  newStock,
		Delta:     cmd.Delta,
	})
}

// ─── Events ───

type ProductCreatedEvent struct {
	ProductID string
	Name      string
	Price     int64
	Stock     int
}

type StockUpdatedEvent struct {
	ProductID string
	NewStock  int
	Delta     int
}

// ─── Read Model Projector ───

// InMemoryReadStore projects events into a read-optimized store
type InMemoryReadStore struct {
	mu       sync.RWMutex
	products map[string]*ProductReadModel
}

func NewInMemoryReadStore() *InMemoryReadStore {
	return &InMemoryReadStore{
		products: make(map[string]*ProductReadModel),
	}
}

func (s *InMemoryReadStore) Handle(ctx context.Context, event any) error {
	switch e := event.(type) {
	case ProductCreatedEvent:
		s.mu.Lock()
		s.products[e.ProductID] = &ProductReadModel{
			ID:             e.ProductID,
			Name:           e.Name,
			Price:          e.Price,
			PriceFormatted: formatPrice(e.Price),
			Stock:          e.Stock,
			InStock:        e.Stock > 0,
		}
		s.mu.Unlock()

	case StockUpdatedEvent:
		s.mu.Lock()
		if p, ok := s.products[e.ProductID]; ok {
			p.Stock = e.NewStock
			p.InStock = e.NewStock > 0
		}
		s.mu.Unlock()
	}
	return nil
}

func (s *InMemoryReadStore) FindByID(ctx context.Context, id string) (*ProductReadModel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	p, ok := s.products[id]
	if !ok {
		return nil, fmt.Errorf("product not found: %s", id)
	}
	// Return copy to prevent mutation
	copy := *p
	return &copy, nil
}

func (s *InMemoryReadStore) Search(ctx context.Context, q SearchProductsQuery) ([]*ProductReadModel, int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var results []*ProductReadModel
	for _, p := range s.products {
		if q.Name != "" && !strings.Contains(strings.ToLower(p.Name), strings.ToLower(q.Name)) {
			continue
		}
		if q.MaxPrice > 0 && p.Price > q.MaxPrice {
			continue
		}
		copy := *p
		results = append(results, &copy)
	}

	total := len(results)
	start := (q.Page - 1) * q.PageSize
	end := start + q.PageSize
	if start > total {
		return nil, total, nil
	}
	if end > total {
		end = total
	}

	return results[start:end], total, nil
}

func formatPrice(cents int64) string {
	return fmt.Sprintf("$%.2f", float64(cents)/100)
}

func generateID() string {
	return fmt.Sprintf("prod-%d", time.Now().UnixNano())
}
```

---
