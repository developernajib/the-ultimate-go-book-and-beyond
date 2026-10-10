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

	"github.com/example/ecommerce-platform/services/product/internal/domain"
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

	if len(product.CategoryIDs) > 0 {
		if err := r.addCategories(ctx, product.ID, product.CategoryIDs); err != nil {
			return fmt.Errorf("adding categories: %w", err)
		}
	}

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

	categoryIDs, err := r.getProductCategories(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("getting categories: %w", err)
	}
	product.CategoryIDs = categoryIDs

	variants, err := r.getProductVariants(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("getting variants: %w", err)
	}
	product.Variants = variants

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

	countQuery := "SELECT COUNT(*) FROM (" + query + ") AS count_query"
	var total int
	if err := r.pool.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("counting products: %w", err)
	}

	query += fmt.Sprintf(" ORDER BY p.created_at DESC LIMIT $%d OFFSET $%d", argPos, argPos+1)
	args = append(args, filter.PageSize, filter.Offset)

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

// ensure decimal is used
var _ = decimal.Zero
