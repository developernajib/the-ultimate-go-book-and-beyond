## Part 2: Product Service

The Product Service manages the product catalog, including products, categories, variants, and inventory. This is often the first service you build in an e-commerce system because almost every other service depends on product data. The service exposes a gRPC API for internal communication with other services, and it uses PostgreSQL to store product records with full support for categories and pricing. You will also see how to implement the repository pattern to keep your database logic separate from your business rules.

### 2.1 Product Service Proto Definition

**services/product/proto/product.proto**

```protobuf
syntax = "proto3";

package product;
option go_package = "github.com/yourusername/ecommerce/services/product/proto";

import "google/protobuf/timestamp.proto";
import "proto/common/types.proto";

service ProductService {
  // Product CRUD
  rpc CreateProduct(CreateProductRequest) returns (CreateProductResponse);
  rpc GetProduct(GetProductRequest) returns (GetProductResponse);
  rpc UpdateProduct(UpdateProductRequest) returns (UpdateProductResponse);
  rpc DeleteProduct(DeleteProductRequest) returns (DeleteProductResponse);
  rpc ListProducts(ListProductsRequest) returns (ListProductsResponse);

  // Inventory management
  rpc CheckInventory(CheckInventoryRequest) returns (CheckInventoryResponse);
  rpc ReserveInventory(ReserveInventoryRequest) returns (ReserveInventoryResponse);
  rpc ReleaseInventory(ReleaseInventoryRequest) returns (ReleaseInventoryResponse);
  rpc CommitInventory(CommitInventoryRequest) returns (CommitInventoryResponse);

  // Categories
  rpc ListCategories(ListCategoriesRequest) returns (ListCategoriesResponse);
}

message Product {
  string id = 1;
  string name = 2;
  string description = 3;
  string sku = 4;
  common.Money price = 5;
  int32 inventory = 6;
  repeated string category_ids = 7;
  repeated ProductVariant variants = 8;
  repeated ProductImage images = 9;
  ProductStatus status = 10;
  map<string, string> metadata = 11;
  google.protobuf.Timestamp created_at = 12;
  google.protobuf.Timestamp updated_at = 13;
}

message ProductVariant {
  string id = 1;
  string product_id = 2;
  string name = 3;
  string sku = 4;
  common.Money price = 5;
  int32 inventory = 6;
  map<string, string> attributes = 7; // e.g., "color": "red", "size": "M"
}

message ProductImage {
  string id = 1;
  string url = 2;
  string alt_text = 3;
  int32 order = 4;
}

enum ProductStatus {
  PRODUCT_STATUS_UNSPECIFIED = 0;
  PRODUCT_STATUS_ACTIVE = 1;
  PRODUCT_STATUS_INACTIVE = 2;
  PRODUCT_STATUS_OUT_OF_STOCK = 3;
  PRODUCT_STATUS_DISCONTINUED = 4;
}

message Category {
  string id = 1;
  string name = 2;
  string slug = 3;
  string parent_id = 4;
  int32 order = 5;
}

message CreateProductRequest {
  string name = 1;
  string description = 2;
  string sku = 3;
  common.Money price = 4;
  int32 inventory = 5;
  repeated string category_ids = 6;
  repeated ProductVariant variants = 7;
  map<string, string> metadata = 8;
}

message CreateProductResponse {
  Product product = 1;
}

message GetProductRequest {
  string id = 1;
}

message GetProductResponse {
  Product product = 1;
}

message UpdateProductRequest {
  string id = 1;
  optional string name = 2;
  optional string description = 3;
  optional common.Money price = 4;
  optional int32 inventory = 5;
  optional ProductStatus status = 6;
}

message UpdateProductResponse {
  Product product = 1;
}

message DeleteProductRequest {
  string id = 1;
}

message DeleteProductResponse {
  bool success = 1;
}

message ListProductsRequest {
  repeated string category_ids = 1;
  ProductStatus status = 2;
  common.PageRequest page = 3;
  string search_query = 4;
}

message ListProductsResponse {
  repeated Product products = 1;
  common.PageResponse page = 2;
}

message CheckInventoryRequest {
  string product_id = 1;
  optional string variant_id = 2;
  int32 quantity = 3;
}

message CheckInventoryResponse {
  bool available = 1;
  int32 current_inventory = 2;
}

message ReserveInventoryRequest {
  string reservation_id = 1;
  repeated InventoryItem items = 2;
}

message InventoryItem {
  string product_id = 1;
  optional string variant_id = 2;
  int32 quantity = 3;
}

message ReserveInventoryResponse {
  bool success = 1;
  string reservation_id = 2;
  google.protobuf.Timestamp expires_at = 3;
}

message ReleaseInventoryRequest {
  string reservation_id = 1;
}

message ReleaseInventoryResponse {
  bool success = 1;
}

message CommitInventoryRequest {
  string reservation_id = 1;
}

message CommitInventoryResponse {
  bool success = 1;
}

message ListCategoriesRequest {
  optional string parent_id = 1;
}

message ListCategoriesResponse {
  repeated Category categories = 1;
}
```

### 2.2 Product Service Domain Models

**services/product/internal/domain/product.go**

```go
package domain

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Product represents a product in the catalog
type Product struct {
	ID          uuid.UUID
	Name        string
	Description string
	SKU         string
	Price       decimal.Decimal
	Currency    string
	Inventory   int32
	CategoryIDs []uuid.UUID
	Variants    []ProductVariant
	Images      []ProductImage
	Status      ProductStatus
	Metadata    map[string]string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// ProductVariant represents a product variant
type ProductVariant struct {
	ID         uuid.UUID
	ProductID  uuid.UUID
	Name       string
	SKU        string
	Price      decimal.Decimal
	Currency   string
	Inventory  int32
	Attributes map[string]string
}

// ProductImage represents a product image
type ProductImage struct {
	ID      uuid.UUID
	URL     string
	AltText string
	Order   int32
}

// ProductStatus represents the status of a product
type ProductStatus string

const (
	ProductStatusActive        ProductStatus = "active"
	ProductStatusInactive      ProductStatus = "inactive"
	ProductStatusOutOfStock    ProductStatus = "out_of_stock"
	ProductStatusDiscontinued  ProductStatus = "discontinued"
)

// Category represents a product category
type Category struct {
	ID       uuid.UUID
	Name     string
	Slug     string
	ParentID *uuid.UUID
	Order    int32
}

// InventoryReservation represents a temporary inventory reservation
type InventoryReservation struct {
	ID        uuid.UUID
	ProductID uuid.UUID
	VariantID *uuid.UUID
	Quantity  int32
	ExpiresAt time.Time
	Status    ReservationStatus
	CreatedAt time.Time
}

// ReservationStatus represents the status of an inventory reservation
type ReservationStatus string

const (
	ReservationStatusPending   ReservationStatus = "pending"
	ReservationStatusCommitted ReservationStatus = "committed"
	ReservationStatusReleased  ReservationStatus = "released"
	ReservationStatusExpired   ReservationStatus = "expired"
)

// Validate validates the product
func (p *Product) Validate() error {
	if p.Name == "" {
		return ErrInvalidProductName
	}
	if p.SKU == "" {
		return ErrInvalidSKU
	}
	if p.Price.LessThan(decimal.Zero) {
		return ErrInvalidPrice
	}
	if p.Inventory < 0 {
		return ErrInvalidInventory
	}
	return nil
}

// IsAvailable checks if the product has sufficient inventory
func (p *Product) IsAvailable(quantity int32) bool {
	return p.Inventory >= quantity && p.Status == ProductStatusActive
}

// CanReserve checks if inventory can be reserved
func (r *InventoryReservation) CanReserve() bool {
	return r.Status == ReservationStatusPending && time.Now().Before(r.ExpiresAt)
}
```

**services/product/internal/domain/errors.go**

```go
package domain

import "errors"

var (
	ErrProductNotFound        = errors.New("product not found")
	ErrCategoryNotFound       = errors.New("category not found")
	ErrInvalidProductName     = errors.New("invalid product name")
	ErrInvalidSKU             = errors.New("invalid SKU")
	ErrInvalidPrice           = errors.New("invalid price")
	ErrInvalidInventory       = errors.New("invalid inventory")
	ErrInsufficientInventory  = errors.New("insufficient inventory")
	ErrReservationNotFound    = errors.New("reservation not found")
	ErrReservationExpired     = errors.New("reservation expired")
	ErrReservationAlreadyUsed = errors.New("reservation already used")
	ErrDuplicateSKU           = errors.New("duplicate SKU")
)
```

### 2.3 Product Repository **services/product/internal/repository/product_repository.go**

```go
package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/yourusername/ecommerce/services/product/internal/domain"
)

// ProductRepository handles product persistence
type ProductRepository struct {
	pool *pgxpool.Pool
}

// NewProductRepository creates a new ProductRepository
func NewProductRepository(pool *pgxpool.Pool) *ProductRepository {
	return &ProductRepository{pool: pool}
}

// Create creates a new product
func (r *ProductRepository) Create(ctx context.Context, product *domain.Product) error {
	query := `
		INSERT INTO products (
			id, name, description, sku, price, currency, inventory,
			status, metadata, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
		)
	`

	_, err := r.pool.Exec(ctx, query,
		product.ID,
		product.Name,
		product.Description,
		product.SKU,
		product.Price,
		product.Currency,
		product.Inventory,
		product.Status,
		product.Metadata,
		product.CreatedAt,
		product.UpdatedAt,
	)

	if err != nil {
		return fmt.Errorf("creating product: %w", err)
	}

	// Insert categories
	if len(product.CategoryIDs) > 0 {
		if err := r.addCategories(ctx, product.ID, product.CategoryIDs); err != nil {
			return fmt.Errorf("adding categories: %w", err)
		}
	}

	// Insert variants
	for _, variant := range product.Variants {
		if err := r.createVariant(ctx, &variant); err != nil {
			return fmt.Errorf("creating variant: %w", err)
		}
	}

	return nil
}

// GetByID retrieves a product by ID
func (r *ProductRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Product, error) {
	query := `
		SELECT
			id, name, description, sku, price, currency, inventory,
			status, metadata, created_at, updated_at
		FROM products
		WHERE id = $1
	`

	var product domain.Product
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&product.ID,
		&product.Name,
		&product.Description,
		&product.SKU,
		&product.Price,
		&product.Currency,
		&product.Inventory,
		&product.Status,
		&product.Metadata,
		&product.CreatedAt,
		&product.UpdatedAt,
	)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrProductNotFound
		}
		return nil, fmt.Errorf("getting product: %w", err)
	}

	// Load categories
	categoryIDs, err := r.getProductCategories(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("getting categories: %w", err)
	}
	product.CategoryIDs = categoryIDs

	// Load variants
	variants, err := r.getProductVariants(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("getting variants: %w", err)
	}
	product.Variants = variants

	// Load images
	images, err := r.getProductImages(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("getting images: %w", err)
	}
	product.Images = images

	return &product, nil
}

// Update updates a product
func (r *ProductRepository) Update(ctx context.Context, product *domain.Product) error {
	query := `
		UPDATE products
		SET
			name = $2,
			description = $3,
			price = $4,
			inventory = $5,
			status = $6,
			metadata = $7,
			updated_at = $8
		WHERE id = $1
	`

	result, err := r.pool.Exec(ctx, query,
		product.ID,
		product.Name,
		product.Description,
		product.Price,
		product.Inventory,
		product.Status,
		product.Metadata,
		time.Now(),
	)

	if err != nil {
		return fmt.Errorf("updating product: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.ErrProductNotFound
	}

	return nil
}

// Delete deletes a product
func (r *ProductRepository) Delete(ctx context.Context, id uuid.UUID) error {
	query := `DELETE FROM products WHERE id = $1`

	result, err := r.pool.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("deleting product: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.ErrProductNotFound
	}

	return nil
}

// List retrieves products with filtering and pagination
func (r *ProductRepository) List(ctx context.Context, filter ProductFilter) ([]*domain.Product, int, error) {
	// Build query
	query := `
		SELECT
			p.id, p.name, p.description, p.sku, p.price, p.currency,
			p.inventory, p.status, p.metadata, p.created_at, p.updated_at
		FROM products p
	`

	var conditions []string
	var args []any
	argPos := 1

	if len(filter.CategoryIDs) > 0 {
		query += `
			INNER JOIN product_categories pc ON p.id = pc.product_id
		`
		conditions = append(conditions, fmt.Sprintf("pc.category_id = ANY($%d)", argPos))
		args = append(args, filter.CategoryIDs)
		argPos++
	}

	if filter.Status != "" {
		conditions = append(conditions, fmt.Sprintf("p.status = $%d", argPos))
		args = append(args, filter.Status)
		argPos++
	}

	if filter.SearchQuery != "" {
		conditions = append(conditions, fmt.Sprintf("(p.name ILIKE $%d OR p.description ILIKE $%d)", argPos, argPos))
		args = append(args, "%"+filter.SearchQuery+"%")
		argPos++
	}

	if len(conditions) > 0 {
		query += " WHERE " + conditions[0]
		for _, cond := range conditions[1:] {
			query += " AND " + cond
		}
	}

	// Count total
	countQuery := "SELECT COUNT(*) FROM (" + query + ") AS count_query"
	var total int
	if err := r.pool.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("counting products: %w", err)
	}

	// Add pagination
	query += fmt.Sprintf(" ORDER BY p.created_at DESC LIMIT $%d OFFSET $%d", argPos, argPos+1)
	args = append(args, filter.PageSize, filter.Offset)

	// Execute query
	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("listing products: %w", err)
	}
	defer rows.Close()

	var products []*domain.Product
	for rows.Next() {
		var product domain.Product
		if err := rows.Scan(
			&product.ID,
			&product.Name,
			&product.Description,
			&product.SKU,
			&product.Price,
			&product.Currency,
			&product.Inventory,
			&product.Status,
			&product.Metadata,
			&product.CreatedAt,
			&product.UpdatedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scanning product: %w", err)
		}
		products = append(products, &product)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterating products: %w", err)
	}

	return products, total, nil
}

// ProductFilter represents product filtering options
type ProductFilter struct {
	CategoryIDs []uuid.UUID
	Status      domain.ProductStatus
	SearchQuery string
	PageSize    int
	Offset      int
}

// Helper methods

func (r *ProductRepository) addCategories(ctx context.Context, productID uuid.UUID, categoryIDs []uuid.UUID) error {
	query := `
		INSERT INTO product_categories (product_id, category_id)
		VALUES ($1, $2)
		ON CONFLICT DO NOTHING
	`

	batch := &pgx.Batch{}
	for _, categoryID := range categoryIDs {
		batch.Queue(query, productID, categoryID)
	}

	results := r.pool.SendBatch(ctx, batch)
	defer results.Close()

	for range categoryIDs {
		if _, err := results.Exec(); err != nil {
			return fmt.Errorf("adding category: %w", err)
		}
	}

	return nil
}

func (r *ProductRepository) getProductCategories(ctx context.Context, productID uuid.UUID) ([]uuid.UUID, error) {
	query := `
		SELECT category_id
		FROM product_categories
		WHERE product_id = $1
	`

	rows, err := r.pool.Query(ctx, query, productID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var categoryIDs []uuid.UUID
	for rows.Next() {
		var categoryID uuid.UUID
		if err := rows.Scan(&categoryID); err != nil {
			return nil, err
		}
		categoryIDs = append(categoryIDs, categoryID)
	}

	return categoryIDs, rows.Err()
}

func (r *ProductRepository) createVariant(ctx context.Context, variant *domain.ProductVariant) error {
	query := `
		INSERT INTO product_variants (
			id, product_id, name, sku, price, currency, inventory, attributes
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8
		)
	`

	_, err := r.pool.Exec(ctx, query,
		variant.ID,
		variant.ProductID,
		variant.Name,
		variant.SKU,
		variant.Price,
		variant.Currency,
		variant.Inventory,
		variant.Attributes,
	)

	return err
}

func (r *ProductRepository) getProductVariants(ctx context.Context, productID uuid.UUID) ([]domain.ProductVariant, error) {
	query := `
		SELECT id, product_id, name, sku, price, currency, inventory, attributes
		FROM product_variants
		WHERE product_id = $1
		ORDER BY name
	`

	rows, err := r.pool.Query(ctx, query, productID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var variants []domain.ProductVariant
	for rows.Next() {
		var variant domain.ProductVariant
		if err := rows.Scan(
			&variant.ID,
			&variant.ProductID,
			&variant.Name,
			&variant.SKU,
			&variant.Price,
			&variant.Currency,
			&variant.Inventory,
			&variant.Attributes,
		); err != nil {
			return nil, err
		}
		variants = append(variants, variant)
	}

	return variants, rows.Err()
}

func (r *ProductRepository) getProductImages(ctx context.Context, productID uuid.UUID) ([]domain.ProductImage, error) {
	query := `
		SELECT id, url, alt_text, "order"
		FROM product_images
		WHERE product_id = $1
		ORDER BY "order"
	`

	rows, err := r.pool.Query(ctx, query, productID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []domain.ProductImage
	for rows.Next() {
		var image domain.ProductImage
		if err := rows.Scan(&image.ID, &image.URL, &image.AltText, &image.Order); err != nil {
			return nil, err
		}
		images = append(images, image)
	}

	return images, rows.Err()
}
```

**services/product/internal/repository/inventory_repository.go**

```go
package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yourusername/ecommerce/services/product/internal/domain"
)

// InventoryRepository handles inventory and reservation persistence
type InventoryRepository struct {
	pool *pgxpool.Pool
}

// NewInventoryRepository creates a new InventoryRepository
func NewInventoryRepository(pool *pgxpool.Pool) *InventoryRepository {
	return &InventoryRepository{pool: pool}
}

// CheckInventory checks if inventory is available
func (r *InventoryRepository) CheckInventory(
	ctx context.Context,
	productID uuid.UUID,
	variantID *uuid.UUID,
	quantity int32,
) (bool, int32, error) {
	var currentInventory int32

	if variantID != nil {
		query := `SELECT inventory FROM product_variants WHERE id = $1`
		err := r.pool.QueryRow(ctx, query, *variantID).Scan(&currentInventory)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, 0, domain.ErrProductNotFound
			}
			return false, 0, fmt.Errorf("checking variant inventory: %w", err)
		}
	} else {
		query := `SELECT inventory FROM products WHERE id = $1`
		err := r.pool.QueryRow(ctx, query, productID).Scan(&currentInventory)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, 0, domain.ErrProductNotFound
			}
			return false, 0, fmt.Errorf("checking product inventory: %w", err)
		}
	}

	// Check reserved inventory
	reservedQuery := `
		SELECT COALESCE(SUM(quantity), 0)
		FROM inventory_reservations
		WHERE product_id = $1
			AND ($2::uuid IS NULL OR variant_id = $2)
			AND status = $3
			AND expires_at > NOW()
	`
	var reserved int32
	if err := r.pool.QueryRow(ctx, reservedQuery, productID, variantID, domain.ReservationStatusPending).Scan(&reserved); err != nil {
		return false, 0, fmt.Errorf("checking reserved inventory: %w", err)
	}

	available := currentInventory - reserved
	return available >= quantity, available, nil
}

// ReserveInventory creates an inventory reservation
func (r *InventoryRepository) ReserveInventory(
	ctx context.Context,
	reservationID uuid.UUID,
	productID uuid.UUID,
	variantID *uuid.UUID,
	quantity int32,
	expiresAt time.Time,
) error {
	// Check if inventory is available
	available, _, err := r.CheckInventory(ctx, productID, variantID, quantity)
	if err != nil {
		return err
	}
	if !available {
		return domain.ErrInsufficientInventory
	}

	// Create reservation
	query := `
		INSERT INTO inventory_reservations (
			id, product_id, variant_id, quantity, expires_at, status, created_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7
		)
	`

	_, err = r.pool.Exec(ctx, query,
		reservationID,
		productID,
		variantID,
		quantity,
		expiresAt,
		domain.ReservationStatusPending,
		time.Now(),
	)

	if err != nil {
		return fmt.Errorf("creating reservation: %w", err)
	}

	return nil
}

// ReleaseInventory releases a reservation
func (r *InventoryRepository) ReleaseInventory(ctx context.Context, reservationID uuid.UUID) error {
	query := `
		UPDATE inventory_reservations
		SET status = $2
		WHERE id = $1 AND status = $3
	`

	result, err := r.pool.Exec(ctx, query,
		reservationID,
		domain.ReservationStatusReleased,
		domain.ReservationStatusPending,
	)

	if err != nil {
		return fmt.Errorf("releasing reservation: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.ErrReservationNotFound
	}

	return nil
}

// CommitInventory commits a reservation and reduces actual inventory
func (r *InventoryRepository) CommitInventory(ctx context.Context, reservationID uuid.UUID) error {
	// Start transaction
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Get reservation
	var reservation domain.InventoryReservation
	query := `
		SELECT product_id, variant_id, quantity, status, expires_at
		FROM inventory_reservations
		WHERE id = $1
		FOR UPDATE
	`

	err = tx.QueryRow(ctx, query, reservationID).Scan(
		&reservation.ProductID,
		&reservation.VariantID,
		&reservation.Quantity,
		&reservation.Status,
		&reservation.ExpiresAt,
	)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrReservationNotFound
		}
		return fmt.Errorf("getting reservation: %w", err)
	}

	// Check reservation status
	if reservation.Status != domain.ReservationStatusPending {
		return domain.ErrReservationAlreadyUsed
	}

	if time.Now().After(reservation.ExpiresAt) {
		return domain.ErrReservationExpired
	}

	// Update inventory
	var updateQuery string
	if reservation.VariantID != nil {
		updateQuery = `
			UPDATE product_variants
			SET inventory = inventory - $1
			WHERE id = $2 AND inventory >= $1
		`
	} else {
		updateQuery = `
			UPDATE products
			SET inventory = inventory - $1
			WHERE id = $2 AND inventory >= $1
		`
	}

	var targetID uuid.UUID
	if reservation.VariantID != nil {
		targetID = *reservation.VariantID
	} else {
		targetID = reservation.ProductID
	}

	result, err := tx.Exec(ctx, updateQuery, reservation.Quantity, targetID)
	if err != nil {
		return fmt.Errorf("updating inventory: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.ErrInsufficientInventory
	}

	// Mark reservation as committed
	updateReservationQuery := `
		UPDATE inventory_reservations
		SET status = $2
		WHERE id = $1
	`

	_, err = tx.Exec(ctx, updateReservationQuery, reservationID, domain.ReservationStatusCommitted)
	if err != nil {
		return fmt.Errorf("updating reservation: %w", err)
	}

	// Commit transaction
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}

	return nil
}

// CleanupExpiredReservations removes expired reservations
func (r *InventoryRepository) CleanupExpiredReservations(ctx context.Context) error {
	query := `
		UPDATE inventory_reservations
		SET status = $1
		WHERE status = $2 AND expires_at < NOW()
	`

	_, err := r.pool.Exec(ctx, query, domain.ReservationStatusExpired, domain.ReservationStatusPending)
	if err != nil {
		return fmt.Errorf("cleaning up expired reservations: %w", err)
	}

	return nil
}
```

### 2.4 Product Service Implementation

**services/product/internal/service/product_service.go**

```go
package service

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/yourusername/ecommerce/services/product/internal/domain"
	"github.com/yourusername/ecommerce/services/product/internal/repository"
)

// ProductService implements business logic for products
type ProductService struct {
	productRepo   *repository.ProductRepository
	inventoryRepo *repository.InventoryRepository
	categoryRepo  *repository.CategoryRepository
}

// NewProductService creates a new ProductService
func NewProductService(
	productRepo *repository.ProductRepository,
	inventoryRepo *repository.InventoryRepository,
	categoryRepo *repository.CategoryRepository,
) *ProductService {
	return &ProductService{
		productRepo:   productRepo,
		inventoryRepo: inventoryRepo,
		categoryRepo:  categoryRepo,
	}
}

// CreateProduct creates a new product
func (s *ProductService) CreateProduct(ctx context.Context, product *domain.Product) (*domain.Product, error) {
	// Validate product
	if err := product.Validate(); err != nil {
		return nil, fmt.Errorf("invalid product: %w", err)
	}

	// Set timestamps
	now := time.Now()
	product.ID = uuid.New()
	product.CreatedAt = now
	product.UpdatedAt = now

	// Generate variant IDs
	for i := range product.Variants {
		product.Variants[i].ID = uuid.New()
		product.Variants[i].ProductID = product.ID
	}

	// Create product
	if err := s.productRepo.Create(ctx, product); err != nil {
		return nil, fmt.Errorf("creating product: %w", err)
	}

	return product, nil
}

// GetProduct retrieves a product by ID
func (s *ProductService) GetProduct(ctx context.Context, id uuid.UUID) (*domain.Product, error) {
	product, err := s.productRepo.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("getting product: %w", err)
	}

	return product, nil
}

// UpdateProduct updates a product
func (s *ProductService) UpdateProduct(ctx context.Context, product *domain.Product) (*domain.Product, error) {
	// Validate product
	if err := product.Validate(); err != nil {
		return nil, fmt.Errorf("invalid product: %w", err)
	}

	// Update timestamp
	product.UpdatedAt = time.Now()

	// Update product
	if err := s.productRepo.Update(ctx, product); err != nil {
		return nil, fmt.Errorf("updating product: %w", err)
	}

	return product, nil
}

// DeleteProduct deletes a product
func (s *ProductService) DeleteProduct(ctx context.Context, id uuid.UUID) error {
	if err := s.productRepo.Delete(ctx, id); err != nil {
		return fmt.Errorf("deleting product: %w", err)
	}

	return nil
}

// ListProducts retrieves products with filtering
func (s *ProductService) ListProducts(
	ctx context.Context,
	categoryIDs []uuid.UUID,
	status domain.ProductStatus,
	searchQuery string,
	page, pageSize int,
) ([]*domain.Product, int, error) {
	filter := repository.ProductFilter{
		CategoryIDs: categoryIDs,
		Status:      status,
		SearchQuery: searchQuery,
		PageSize:    pageSize,
		Offset:      (page - 1) * pageSize,
	}

	products, total, err := s.productRepo.List(ctx, filter)
	if err != nil {
		return nil, 0, fmt.Errorf("listing products: %w", err)
	}

	return products, total, nil
}

// CheckInventory checks if inventory is available
func (s *ProductService) CheckInventory(
	ctx context.Context,
	productID uuid.UUID,
	variantID *uuid.UUID,
	quantity int32,
) (bool, int32, error) {
	available, currentInventory, err := s.inventoryRepo.CheckInventory(ctx, productID, variantID, quantity)
	if err != nil {
		return false, 0, fmt.Errorf("checking inventory: %w", err)
	}

	return available, currentInventory, nil
}

// ReserveInventory reserves inventory for a purchase
func (s *ProductService) ReserveInventory(
	ctx context.Context,
	items []domain.InventoryReservation,
	expirationMinutes int,
) (uuid.UUID, time.Time, error) {
	reservationID := uuid.New()
	expiresAt := time.Now().Add(time.Duration(expirationMinutes) * time.Minute)

	// Reserve each item
	for _, item := range items {
		err := s.inventoryRepo.ReserveInventory(
			ctx,
			reservationID,
			item.ProductID,
			item.VariantID,
			item.Quantity,
			expiresAt,
		)
		if err != nil {
			// Attempt to release any successful reservations
			_ = s.inventoryRepo.ReleaseInventory(ctx, reservationID)
			return uuid.Nil, time.Time{}, fmt.Errorf("reserving inventory: %w", err)
		}
	}

	return reservationID, expiresAt, nil
}

// ReleaseInventory releases a reservation
func (s *ProductService) ReleaseInventory(ctx context.Context, reservationID uuid.UUID) error {
	if err := s.inventoryRepo.ReleaseInventory(ctx, reservationID); err != nil {
		return fmt.Errorf("releasing inventory: %w", err)
	}

	return nil
}

// CommitInventory commits a reservation
func (s *ProductService) CommitInventory(ctx context.Context, reservationID uuid.UUID) error {
	if err := s.inventoryRepo.CommitInventory(ctx, reservationID); err != nil {
		return fmt.Errorf("committing inventory: %w", err)
	}

	return nil
}
```

### 2.5 Product Service gRPC Server **services/product/internal/grpc/server.go**

```go
package grpc

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/yourusername/ecommerce/services/product/internal/domain"
	"github.com/yourusername/ecommerce/services/product/internal/service"
	pb "github.com/yourusername/ecommerce/services/product/proto"
)

// Server implements the ProductService gRPC server
type Server struct {
	pb.UnimplementedProductServiceServer
	productService *service.ProductService
}

// NewServer creates a new gRPC server
func NewServer(productService *service.ProductService) *Server {
	return &Server{
		productService: productService,
	}
}

// CreateProduct creates a new product
func (s *Server) CreateProduct(ctx context.Context, req *pb.CreateProductRequest) (*pb.CreateProductResponse, error) {
	// Convert request to domain model
	product := &domain.Product{
		Name:        req.Name,
		Description: req.Description,
		SKU:         req.Sku,
		Metadata:    req.Metadata,
	}

	// Parse price
	if req.Price != nil {
		product.Currency = req.Price.CurrencyCode
		product.Price = moneyToDecimal(req.Price)
	}

	product.Inventory = req.Inventory

	// Parse category IDs
	for _, idStr := range req.CategoryIds {
		categoryID, err := uuid.Parse(idStr)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid category ID: %v", err)
		}
		product.CategoryIDs = append(product.CategoryIDs, categoryID)
	}

	// Parse variants
	for _, v := range req.Variants {
		variant := domain.ProductVariant{
			Name:       v.Name,
			SKU:        v.Sku,
			Currency:   v.Price.CurrencyCode,
			Price:      moneyToDecimal(v.Price),
			Inventory:  v.Inventory,
			Attributes: v.Attributes,
		}
		product.Variants = append(product.Variants, variant)
	}

	// Create product
	created, err := s.productService.CreateProduct(ctx, product)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "creating product: %v", err)
	}

	return &pb.CreateProductResponse{
		Product: domainProductToProto(created),
	}, nil
}

// GetProduct retrieves a product
func (s *Server) GetProduct(ctx context.Context, req *pb.GetProductRequest) (*pb.GetProductResponse, error) {
	id, err := uuid.Parse(req.Id)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
	}

	product, err := s.productService.GetProduct(ctx, id)
	if err != nil {
		if err == domain.ErrProductNotFound {
			return nil, status.Error(codes.NotFound, "product not found")
		}
		return nil, status.Errorf(codes.Internal, "getting product: %v", err)
	}

	return &pb.GetProductResponse{
		Product: domainProductToProto(product),
	}, nil
}

// UpdateProduct updates a product
func (s *Server) UpdateProduct(ctx context.Context, req *pb.UpdateProductRequest) (*pb.UpdateProductResponse, error) {
	id, err := uuid.Parse(req.Id)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
	}

	// Get existing product
	product, err := s.productService.GetProduct(ctx, id)
	if err != nil {
		if err == domain.ErrProductNotFound {
			return nil, status.Error(codes.NotFound, "product not found")
		}
		return nil, status.Errorf(codes.Internal, "getting product: %v", err)
	}

	// Update fields
	if req.Name != nil {
		product.Name = *req.Name
	}
	if req.Description != nil {
		product.Description = *req.Description
	}
	if req.Price != nil {
		product.Price = moneyToDecimal(req.Price)
		product.Currency = req.Price.CurrencyCode
	}
	if req.Inventory != nil {
		product.Inventory = *req.Inventory
	}
	if req.Status != pb.ProductStatus_PRODUCT_STATUS_UNSPECIFIED {
		product.Status = protoStatusToDomain(req.Status)
	}

	// Update product
	updated, err := s.productService.UpdateProduct(ctx, product)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "updating product: %v", err)
	}

	return &pb.UpdateProductResponse{
		Product: domainProductToProto(updated),
	}, nil
}

// DeleteProduct deletes a product
func (s *Server) DeleteProduct(ctx context.Context, req *pb.DeleteProductRequest) (*pb.DeleteProductResponse, error) {
	id, err := uuid.Parse(req.Id)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
	}

	if err := s.productService.DeleteProduct(ctx, id); err != nil {
		if err == domain.ErrProductNotFound {
			return nil, status.Error(codes.NotFound, "product not found")
		}
		return nil, status.Errorf(codes.Internal, "deleting product: %v", err)
	}

	return &pb.DeleteProductResponse{Success: true}, nil
}

// ListProducts lists products
func (s *Server) ListProducts(ctx context.Context, req *pb.ListProductsRequest) (*pb.ListProductsResponse, error) {
	// Parse category IDs
	var categoryIDs []uuid.UUID
	for _, idStr := range req.CategoryIds {
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid category ID: %v", err)
		}
		categoryIDs = append(categoryIDs, id)
	}

	// Parse pagination
	page := int(req.Page.Page)
	if page == 0 {
		page = 1
	}
	pageSize := int(req.Page.PageSize)
	if pageSize == 0 {
		pageSize = 20
	}

	// List products
	products, total, err := s.productService.ListProducts(
		ctx,
		categoryIDs,
		protoStatusToDomain(req.Status),
		req.SearchQuery,
		page,
		pageSize,
	)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "listing products: %v", err)
	}

	// Convert to proto
	var protoProducts []*pb.Product
	for _, p := range products {
		protoProducts = append(protoProducts, domainProductToProto(p))
	}

	totalPages := (total + pageSize - 1) / pageSize

	return &pb.ListProductsResponse{
		Products: protoProducts,
		Page: &pb.PageResponse{
			TotalCount: int32(total),
			Page:       int32(page),
			PageSize:   int32(pageSize),
			TotalPages: int32(totalPages),
		},
	}, nil
}

// CheckInventory checks if inventory is available
func (s *Server) CheckInventory(ctx context.Context, req *pb.CheckInventoryRequest) (*pb.CheckInventoryResponse, error) {
	productID, err := uuid.Parse(req.ProductId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
	}

	var variantID *uuid.UUID
	if req.VariantId != nil {
		id, err := uuid.Parse(*req.VariantId)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid variant ID: %v", err)
		}
		variantID = &id
	}

	available, currentInventory, err := s.productService.CheckInventory(ctx, productID, variantID, req.Quantity)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "checking inventory: %v", err)
	}

	return &pb.CheckInventoryResponse{
		Available:        available,
		CurrentInventory: currentInventory,
	}, nil
}

// ReserveInventory reserves inventory
func (s *Server) ReserveInventory(ctx context.Context, req *pb.ReserveInventoryRequest) (*pb.ReserveInventoryResponse, error) {
	// Parse items
	var items []domain.InventoryReservation
	for _, item := range req.Items {
		productID, err := uuid.Parse(item.ProductId)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid product ID: %v", err)
		}

		reservation := domain.InventoryReservation{
			ProductID: productID,
			Quantity:  item.Quantity,
		}

		if item.VariantId != nil {
			variantID, err := uuid.Parse(*item.VariantId)
			if err != nil {
				return nil, status.Errorf(codes.InvalidArgument, "invalid variant ID: %v", err)
			}
			reservation.VariantID = &variantID
		}

		items = append(items, reservation)
	}

	// Reserve inventory (15 minutes expiration)
	reservationID, expiresAt, err := s.productService.ReserveInventory(ctx, items, 15)
	if err != nil {
		if err == domain.ErrInsufficientInventory {
			return nil, status.Error(codes.FailedPrecondition, "insufficient inventory")
		}
		return nil, status.Errorf(codes.Internal, "reserving inventory: %v", err)
	}

	return &pb.ReserveInventoryResponse{
		Success:       true,
		ReservationId: reservationID.String(),
		ExpiresAt:     timestamppb.New(expiresAt),
	}, nil
}

// ReleaseInventory releases a reservation
func (s *Server) ReleaseInventory(ctx context.Context, req *pb.ReleaseInventoryRequest) (*pb.ReleaseInventoryResponse, error) {
	reservationID, err := uuid.Parse(req.ReservationId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid reservation ID: %v", err)
	}

	if err := s.productService.ReleaseInventory(ctx, reservationID); err != nil {
		return nil, status.Errorf(codes.Internal, "releasing inventory: %v", err)
	}

	return &pb.ReleaseInventoryResponse{Success: true}, nil
}

// CommitInventory commits a reservation
func (s *Server) CommitInventory(ctx context.Context, req *pb.CommitInventoryRequest) (*pb.CommitInventoryResponse, error) {
	reservationID, err := uuid.Parse(req.ReservationId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid reservation ID: %v", err)
	}

	if err := s.productService.CommitInventory(ctx, reservationID); err != nil {
		if err == domain.ErrInsufficientInventory {
			return nil, status.Error(codes.FailedPrecondition, "insufficient inventory")
		}
		if err == domain.ErrReservationExpired {
			return nil, status.Error(codes.DeadlineExceeded, "reservation expired")
		}
		return nil, status.Errorf(codes.Internal, "committing inventory: %v", err)
	}

	return &pb.CommitInventoryResponse{Success: true}, nil
}

// ListCategories lists categories
func (s *Server) ListCategories(ctx context.Context, req *pb.ListCategoriesRequest) (*pb.ListCategoriesResponse, error) {
	// This would call the category service - simplified for now
	return &pb.ListCategoriesResponse{
		Categories: []*pb.Category{},
	}, nil
}

// Helper functions

func domainProductToProto(p *domain.Product) *pb.Product {
	product := &pb.Product{
		Id:          p.ID.String(),
		Name:        p.Name,
		Description: p.Description,
		Sku:         p.SKU,
		Price:       decimalToMoney(p.Price, p.Currency),
		Inventory:   p.Inventory,
		Status:      domainStatusToProto(p.Status),
		Metadata:    p.Metadata,
		CreatedAt:   timestamppb.New(p.CreatedAt),
		UpdatedAt:   timestamppb.New(p.UpdatedAt),
	}

	// Convert category IDs
	for _, id := range p.CategoryIDs {
		product.CategoryIds = append(product.CategoryIds, id.String())
	}

	// Convert variants
	for _, v := range p.Variants {
		product.Variants = append(product.Variants, &pb.ProductVariant{
			Id:         v.ID.String(),
			ProductId:  v.ProductID.String(),
			Name:       v.Name,
			Sku:        v.SKU,
			Price:      decimalToMoney(v.Price, v.Currency),
			Inventory:  v.Inventory,
			Attributes: v.Attributes,
		})
	}

	// Convert images
	for _, img := range p.Images {
		product.Images = append(product.Images, &pb.ProductImage{
			Id:      img.ID.String(),
			Url:     img.URL,
			AltText: img.AltText,
			Order:   img.Order,
		})
	}

	return product
}

func domainStatusToProto(status domain.ProductStatus) pb.ProductStatus {
	switch status {
	case domain.ProductStatusActive:
		return pb.ProductStatus_PRODUCT_STATUS_ACTIVE
	case domain.ProductStatusInactive:
		return pb.ProductStatus_PRODUCT_STATUS_INACTIVE
	case domain.ProductStatusOutOfStock:
		return pb.ProductStatus_PRODUCT_STATUS_OUT_OF_STOCK
	case domain.ProductStatusDiscontinued:
		return pb.ProductStatus_PRODUCT_STATUS_DISCONTINUED
	default:
		return pb.ProductStatus_PRODUCT_STATUS_UNSPECIFIED
	}
}

func protoStatusToDomain(status pb.ProductStatus) domain.ProductStatus {
	switch status {
	case pb.ProductStatus_PRODUCT_STATUS_ACTIVE:
		return domain.ProductStatusActive
	case pb.ProductStatus_PRODUCT_STATUS_INACTIVE:
		return domain.ProductStatusInactive
	case pb.ProductStatus_PRODUCT_STATUS_OUT_OF_STOCK:
		return domain.ProductStatusOutOfStock
	case pb.ProductStatus_PRODUCT_STATUS_DISCONTINUED:
		return domain.ProductStatusDiscontinued
	default:
		return ""
	}
}

func moneyToDecimal(m *pb.Money) decimal.Decimal {
	if m == nil {
		return decimal.Zero
	}
	// Convert units (smallest currency unit) to decimal
	// E.g., 1000 cents = $10.00
	return decimal.NewFromInt(int64(m.Units)).Div(decimal.NewFromInt(100))
}

func decimalToMoney(d decimal.Decimal, currency string) *pb.Money {
	// Convert decimal to smallest currency unit
	// E.g., $10.00 = 1000 cents
	units := d.Mul(decimal.NewFromInt(100)).IntPart()
	return &pb.Money{
		CurrencyCode: currency,
		Units:        units,
		Nanos:        0,
	}
}
```

**services/product/cmd/server/main.go**

```go
package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	"github.com/yourusername/ecommerce/pkg/database"
	"github.com/yourusername/ecommerce/pkg/logging"
	"github.com/yourusername/ecommerce/pkg/tracing"
	grpcserver "github.com/yourusername/ecommerce/services/product/internal/grpc"
	"github.com/yourusername/ecommerce/services/product/internal/repository"
	"github.com/yourusername/ecommerce/services/product/internal/service"
	pb "github.com/yourusername/ecommerce/services/product/proto"
)

func main() {
	logger := logging.Default()
	defer logging.Sync()

	if err := run(logger); err != nil {
		logger.Fatal("application failed", zap.Error(err))
	}
}

func run(logger *zap.Logger) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize tracing
	shutdown, err := tracing.InitTracer(tracing.Config{
		ServiceName:    "product-service",
		ServiceVersion: "1.0.0",
		JaegerEndpoint: getEnv("JAEGER_ENDPOINT", "http://localhost:14268/api/traces"),
		Environment:    getEnv("ENVIRONMENT", "development"),
	})
	if err != nil {
		return fmt.Errorf("initializing tracer: %w", err)
	}
	defer shutdown(ctx)

	// Connect to database
	dbConfig := database.Config{
		Host:     getEnv("DB_HOST", "localhost"),
		Port:     5432,
		User:     getEnv("DB_USER", "postgres"),
		Password: getEnv("DB_PASSWORD", "postgres"),
		Database: getEnv("DB_NAME", "product_db"),
	}

	pool, err := database.NewPostgresPool(ctx, dbConfig)
	if err != nil {
		return fmt.Errorf("connecting to database: %w", err)
	}
	defer pool.Close()

	logger.Info("connected to database",
		zap.String("host", dbConfig.Host),
		zap.String("database", dbConfig.Database),
	)

	// Initialize repositories
	productRepo := repository.NewProductRepository(pool)
	inventoryRepo := repository.NewInventoryRepository(pool)
	categoryRepo := repository.NewCategoryRepository(pool)

	// Initialize service
	productService := service.NewProductService(productRepo, inventoryRepo, categoryRepo)

	// Create gRPC server
	grpcServer := grpc.NewServer(
		grpc.UnaryInterceptor(loggingInterceptor(logger)),
	)

	// Register services
	pb.RegisterProductServiceServer(grpcServer, grpcserver.NewServer(productService))
	grpc_health_v1.RegisterHealthServer(grpcServer, health.NewServer())
	reflection.Register(grpcServer)

	// Start gRPC server
	port := getEnv("GRPC_PORT", "50051")
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		return fmt.Errorf("creating listener: %w", err)
	}

	// Start server in goroutine
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("starting gRPC server", zap.String("port", port))
		serverErrors <- grpcServer.Serve(listener)
	}()

	// Start cleanup goroutine for expired reservations
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := inventoryRepo.CleanupExpiredReservations(ctx); err != nil {
					logger.Error("cleaning up expired reservations", zap.Error(err))
				}
			}
		}
	}()

	// Wait for shutdown signal
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-serverErrors:
		return fmt.Errorf("server error: %w", err)
	case sig := <-shutdown:
		logger.Info("shutdown signal received", zap.String("signal", sig.String()))

		// Graceful shutdown
		grpcServer.GracefulStop()
		logger.Info("server stopped")
	}

	return nil
}

func loggingInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		start := time.Now()

		resp, err := handler(ctx, req)

		duration := time.Since(start)
		logger.Info("gRPC request",
			zap.String("method", info.FullMethod),
			zap.Duration("duration", duration),
			zap.Error(err),
		)

		return resp, err
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
```

### 2.6 Database Migrations **services/product/migrations/001_create_products.up.sql**

```sql
-- Products table
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    sku VARCHAR(100) UNIQUE NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    inventory INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    metadata JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_created_at ON products(created_at DESC);

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    parent_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    "order" INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_categories_slug ON categories(slug);
CREATE INDEX idx_categories_parent_id ON categories(parent_id);

-- Product categories junction table
CREATE TABLE IF NOT EXISTS product_categories (
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, category_id)
);

-- Product variants table
CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100) UNIQUE NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    inventory INTEGER NOT NULL DEFAULT 0,
    attributes JSONB
);

CREATE INDEX idx_variants_product_id ON product_variants(product_id);
CREATE INDEX idx_variants_sku ON product_variants(sku);

-- Product images table
CREATE TABLE IF NOT EXISTS product_images (
    id UUID PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL,
    alt_text VARCHAR(255),
    "order" INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_images_product_id ON product_images(product_id);

-- Inventory reservations table
CREATE TABLE IF NOT EXISTS inventory_reservations (
    id UUID PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reservations_product_id ON inventory_reservations(product_id);
CREATE INDEX idx_reservations_status ON inventory_reservations(status);
CREATE INDEX idx_reservations_expires_at ON inventory_reservations(expires_at);
```

Due to length constraints, I'll continue with the remaining services in the next sections. This covers the complete Product Service with: 1. Proto definitions for gRPC
2. Domain models with validation
3. Repository layer with PostgreSQL
4. Inventory management with reservations
5. Complete gRPC server implementation
6. Database migrations The pattern established here will be followed for the other services (Cart, Order, Payment, User, Notification), the Event-Driven architecture with NATS, Elasticsearch integration, and the API Gateway.

### Junior → FAANG: Inventory Management as a Distributed Systems Problem

Inventory deduction (reducing stock count when an item is added to cart versus when it is purchased) is one of the hardest problems in e-commerce. The naive approach (deduct when added to cart) causes items to appear out of stock while sitting in abandoned carts. The other extreme (deduct only when purchased) allows overselling under concurrent checkouts.

The standard production approach is soft reservation: add to cart creates a soft reservation with a TTL (say, 30 minutes). Purchase confirms the reservation and permanently deducts stock. If the reservation expires (cart abandoned or TTL exceeded), stock is returned. This requires an inventory system that supports reservations, not just stock counts.

For interviews, describe inventory management as an atomic decrement problem. `UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock > 0` combined with `RETURNING stock` gives you a conditional decrement that prevents overselling. Know the performance characteristics (this is a row-level lock on the product row, which serializes concurrent purchases of the same product).

### Senior @ FAANG: Product Service as a Data Consistency Domain

At senior level, the product service owns the source of truth for product data. Every other service that needs product information must either call the product service or maintain an eventually-consistent local copy. The ADR for product data propagation must choose: synchronous gRPC call on each request (correct but adds latency), or event-driven cache with eventual consistency (faster but allows stale data).

Search consistency is a specific concern. Elasticsearch (used later in this project) is an eventually-consistent secondary index. A product price update in PostgreSQL may not appear in Elasticsearch for seconds. For a checkout, using Elasticsearch prices is dangerous: the displayed price might differ from the actual price. Checkouts must use PostgreSQL as the authoritative price source, even if the product was discovered via Elasticsearch search. Documenting this dual-read pattern (search via Elasticsearch, transact via PostgreSQL) is required for correctness.

Product variants (sizes, colors) and their independent inventory management introduce combinatorial complexity. A T-shirt with 5 colors and 5 sizes has 25 variants, each with independent stock. The data model, the reservation system, and the Elasticsearch index must all handle variants as first-class entities, not as product attributes. Getting this data model right at the start prevents costly migrations later.

---
