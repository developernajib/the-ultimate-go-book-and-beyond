## 52.3 Product Service

### Product Model and Service

The product service manages the catalog: products, categories, and search. Unlike the user service, which separates the repository into its own type, the product service embeds database access directly because its queries are straightforward CRUD with pagination. The `ProductWithStock` composite struct shows how one service can present enriched data by combining its own fields with information fetched from another service (inventory).

```go
// internal/product/model.go
package product

import (
	"time"
)

// Product represents a product
type Product struct {
	ID          string    `json:"id" db:"id"`
	SKU         string    `json:"sku" db:"sku"`
	Name        string    `json:"name" db:"name"`
	Description string    `json:"description" db:"description"`
	PriceCents  int64     `json:"price_cents" db:"price_cents"`
	CategoryID  string    `json:"category_id" db:"category_id"`
	Brand       string    `json:"brand" db:"brand"`
	ImageURL    string    `json:"image_url" db:"image_url"`
	Status      string    `json:"status" db:"status"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time `json:"updated_at" db:"updated_at"`
}

// Category represents a product category
type Category struct {
	ID          string    `json:"id" db:"id"`
	Name        string    `json:"name" db:"name"`
	Description string    `json:"description" db:"description"`
	ParentID    *string   `json:"parent_id,omitempty" db:"parent_id"`
	Slug        string    `json:"slug" db:"slug"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
}

// ProductWithStock includes inventory info
type ProductWithStock struct {
	Product
	Available int `json:"available"`
	Reserved  int `json:"reserved"`
}
```

The service handles schema creation, CRUD operations, and text search. `ListProducts` builds its query dynamically based on whether a category filter is provided, using positional parameter indexing (`$1`, `$2`, etc.) to avoid SQL injection. `SearchProducts` uses PostgreSQL's `ILIKE` operator for case-insensitive substring matching, adequate for moderate catalog sizes, though a dedicated search engine like Elasticsearch is better for large catalogs with faceted filtering.

```go
// internal/product/service.go
package product

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Service handles product business logic
type Service struct {
	db *sql.DB
}

// NewService creates a product service
func NewService(db *sql.DB) (*Service, error) {
	s := &Service{db: db}
	if err := s.createSchema(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS categories (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name VARCHAR(100) NOT NULL,
			description TEXT,
			parent_id UUID REFERENCES categories(id),
			slug VARCHAR(100) UNIQUE NOT NULL,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE TABLE IF NOT EXISTS products (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			sku VARCHAR(50) UNIQUE NOT NULL,
			name VARCHAR(255) NOT NULL,
			description TEXT,
			price_cents BIGINT NOT NULL,
			category_id UUID REFERENCES categories(id),
			brand VARCHAR(100),
			image_url TEXT,
			status VARCHAR(20) DEFAULT 'active',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
		CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
		CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
	`

	_, err := s.db.Exec(query)
	return err
}

// CreateProduct creates a new product
func (s *Service) CreateProduct(ctx context.Context, product *Product) error {
	product.ID = uuid.New().String()
	product.CreatedAt = time.Now().UTC()
	product.UpdatedAt = time.Now().UTC()
	product.Status = "active"

	query := `
		INSERT INTO products (id, sku, name, description, price_cents, category_id, brand, image_url, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`

	_, err := s.db.ExecContext(ctx, query,
		product.ID, product.SKU, product.Name, product.Description, product.PriceCents,
		product.CategoryID, product.Brand, product.ImageURL, product.Status, product.CreatedAt, product.UpdatedAt,
	)

	return err
}

// GetProduct retrieves a product by ID
func (s *Service) GetProduct(ctx context.Context, id string) (*Product, error) {
	var product Product
	query := `
		SELECT id, sku, name, description, price_cents, category_id, brand, image_url, status, created_at, updated_at
		FROM products WHERE id = $1
	`

	err := s.db.QueryRowContext(ctx, query, id).Scan(
		&product.ID, &product.SKU, &product.Name, &product.Description, &product.PriceCents,
		&product.CategoryID, &product.Brand, &product.ImageURL, &product.Status, &product.CreatedAt, &product.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, ErrProductNotFound
	}

	return &product, err
}

// ListProducts retrieves products with pagination
func (s *Service) ListProducts(ctx context.Context, categoryID string, limit, offset int) ([]Product, int, error) {
	var products []Product
	var total int

	// Count total
	countQuery := `SELECT COUNT(*) FROM products WHERE status = 'active'`
	args := []any{}

	if categoryID != "" {
		countQuery += ` AND category_id = $1`
		args = append(args, categoryID)
	}

	if err := s.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// Get products
	query := `
		SELECT id, sku, name, description, price_cents, category_id, brand, image_url, status, created_at, updated_at
		FROM products WHERE status = 'active'
	`

	if categoryID != "" {
		query += ` AND category_id = $1`
	}

	query += ` ORDER BY created_at DESC LIMIT $` + fmt.Sprintf("%d", len(args)+1) + ` OFFSET $` + fmt.Sprintf("%d", len(args)+2)
	args = append(args, limit, offset)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	for rows.Next() {
		var product Product
		err := rows.Scan(
			&product.ID, &product.SKU, &product.Name, &product.Description, &product.PriceCents,
			&product.CategoryID, &product.Brand, &product.ImageURL, &product.Status, &product.CreatedAt, &product.UpdatedAt,
		)
		if err != nil {
			return nil, 0, err
		}
		products = append(products, product)
	}

	return products, total, rows.Err()
}

// SearchProducts searches products by name
func (s *Service) SearchProducts(ctx context.Context, query string, limit, offset int) ([]Product, error) {
	var products []Product

	sqlQuery := `
		SELECT id, sku, name, description, price_cents, category_id, brand, image_url, status, created_at, updated_at
		FROM products
		WHERE status = 'active' AND (name ILIKE $1 OR description ILIKE $1)
		ORDER BY name
		LIMIT $2 OFFSET $3
	`

	rows, err := s.db.QueryContext(ctx, sqlQuery, "%"+query+"%", limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var product Product
		err := rows.Scan(
			&product.ID, &product.SKU, &product.Name, &product.Description, &product.PriceCents,
			&product.CategoryID, &product.Brand, &product.ImageURL, &product.Status, &product.CreatedAt, &product.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		products = append(products, product)
	}

	return products, rows.Err()
}

// CreateCategory creates a new category
func (s *Service) CreateCategory(ctx context.Context, category *Category) error {
	category.ID = uuid.New().String()
	category.CreatedAt = time.Now().UTC()

	query := `
		INSERT INTO categories (id, name, description, parent_id, slug, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`

	_, err := s.db.ExecContext(ctx, query,
		category.ID, category.Name, category.Description, category.ParentID, category.Slug, category.CreatedAt,
	)

	return err
}

// GetCategories retrieves all categories
func (s *Service) GetCategories(ctx context.Context) ([]Category, error) {
	var categories []Category

	query := `SELECT id, name, description, parent_id, slug, created_at FROM categories ORDER BY name`

	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var category Category
		err := rows.Scan(
			&category.ID, &category.Name, &category.Description, &category.ParentID, &category.Slug, &category.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		categories = append(categories, category)
	}

	return categories, rows.Err()
}

// Errors
var (
	ErrProductNotFound = fmt.Errorf("product not found")
)
```

### Junior → FAANG: Catalog Service Patterns That Appear in Interviews

The product service is often the first service a junior engineer builds, and it contains several patterns that recur in FAANG system design interviews.

**Pagination as a non-optional feature.** `ListProducts` takes `limit` and `offset`. In interviews and in production, never return unbounded results from a catalog query. Explain the two common strategies: offset pagination (simple, but slow on high offsets as the database scans and discards rows) and cursor pagination (the cursor encodes the last-seen primary key or sort key, so the query uses an index regardless of depth). For a product catalog with millions of SKUs, cursor pagination is the correct choice.

**Dynamic query building is a SQL injection surface.** The `ListProducts` method builds the query string dynamically using `fmt.Sprintf` to insert parameter numbers. This is safe when the parameter number is derived from `len(args)` (a controlled integer), not from user input. Get in the habit of tracing every string concatenated into a query back to its source. If it touches user input, it must go through a parameterized binding.

**ILIKE is not production search.** The `SearchProducts` method using `ILIKE '%query%'` cannot use a standard B-tree index and performs a full table scan. For a catalog of ten thousand products, this is acceptable. For a million products, the scan is the bottleneck. The common escalation path is: PostgreSQL full-text search (`tsvector` + `tsquery`) for medium catalogs, then Elasticsearch or Typesense for large catalogs with faceting requirements. Be ready to name this escalation path in interviews.

**First-job habit for catalog services.** Practice adding category-aware queries. "List products in category X, including all subcategories" requires either a recursive CTE (`WITH RECURSIVE`) or an adjacency list traversal. This is a common catalog feature and a good SQL interview problem.

### Senior @ FAANG: Product Catalog Architecture at Scale

The product service as written serves a single-region, single-tenant catalog. At Amazon or Shopify scale, the catalog is one of the most read-heavy systems in the platform and requires a fundamentally different architecture.

**Read-through caching with cache invalidation strategy.** Every `GetProduct` call hits PostgreSQL. At high read rates, this is the bottleneck. The production pattern is: cache product records in Redis or Memcached with a TTL matched to the acceptable staleness window. On write (`UpdateProduct`), invalidate the specific cache key rather than a range key, to avoid thundering herd on popular products. For variant products (a shirt in five colors and three sizes), the cache key design must account for variant dimensions.

**Denormalized read models for different consumers.** The order service needs `{id, name, price}` from the product. The search service needs `{id, name, description, category, brand, tags, in_stock}`. The mobile app needs `{id, name, price_cents, image_url, rating}`. Serving all three from a single normalized database model creates over-fetching and under-fetching problems. The production architecture uses event-driven projections: when a product is updated, the product service emits a `ProductUpdated` event with the full data, and each consumer maintains its own denormalized view. This is CQRS applied at the service level.

**Pricing as a separate bounded context.** The `PriceCents` field on the `Product` model conflates catalog identity with pricing. In production, pricing is its own domain: products have list prices, customer groups have negotiated prices, regions have localized prices, promotions override all of the above. Embedding price in the product model tightly couples catalog management with pricing logic. A staff-level ADR for this system would propose splitting pricing into its own service with a price resolution API: `ResolvePrice(productID, customerID, regionCode, timestamp)` returns the effective price.

**Multi-tenant catalog isolation.** Shopify's catalog is multi-tenant: each merchant has their own product catalog, but merchants may share supplier SKUs. The current model has no `tenant_id` column. Adding multi-tenancy after launch requires migrating every table, adding `tenant_id` to every index, and auditing every query to ensure the tenant filter is applied. The time to design multi-tenancy is before the first table is created, not after the first enterprise customer asks for it.

---
