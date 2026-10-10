package repository

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/example/ecommerce-platform/services/product/internal/domain"
)

// CategoryRepository handles category persistence
type CategoryRepository struct {
	pool *pgxpool.Pool
}

// NewCategoryRepository creates a new CategoryRepository
func NewCategoryRepository(pool *pgxpool.Pool) *CategoryRepository {
	return &CategoryRepository{pool: pool}
}

// GetByID retrieves a category by ID
func (r *CategoryRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Category, error) {
	query := `SELECT id, name, slug, parent_id, "order" FROM categories WHERE id = $1`

	var category domain.Category
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&category.ID,
		&category.Name,
		&category.Slug,
		&category.ParentID,
		&category.Order,
	)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrCategoryNotFound
		}
		return nil, fmt.Errorf("getting category: %w", err)
	}

	return &category, nil
}

// List retrieves categories with optional parent filter
func (r *CategoryRepository) List(ctx context.Context, parentID *uuid.UUID) ([]*domain.Category, error) {
	var query string
	var args []any

	if parentID != nil {
		query = `SELECT id, name, slug, parent_id, "order" FROM categories WHERE parent_id = $1 ORDER BY "order"`
		args = append(args, *parentID)
	} else {
		query = `SELECT id, name, slug, parent_id, "order" FROM categories WHERE parent_id IS NULL ORDER BY "order"`
	}

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("listing categories: %w", err)
	}
	defer rows.Close()

	var categories []*domain.Category
	for rows.Next() {
		var category domain.Category
		if err := rows.Scan(
			&category.ID,
			&category.Name,
			&category.Slug,
			&category.ParentID,
			&category.Order,
		); err != nil {
			return nil, fmt.Errorf("scanning category: %w", err)
		}
		categories = append(categories, &category)
	}

	return categories, rows.Err()
}
