package service

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/example/ecommerce-platform/services/product/internal/domain"
	"github.com/example/ecommerce-platform/services/product/internal/repository"
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
	if err := product.Validate(); err != nil {
		return nil, fmt.Errorf("invalid product: %w", err)
	}

	now := time.Now()
	product.ID = uuid.New()
	product.CreatedAt = now
	product.UpdatedAt = now

	for i := range product.Variants {
		product.Variants[i].ID = uuid.New()
		product.Variants[i].ProductID = product.ID
	}

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
	if err := product.Validate(); err != nil {
		return nil, fmt.Errorf("invalid product: %w", err)
	}

	product.UpdatedAt = time.Now()

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
