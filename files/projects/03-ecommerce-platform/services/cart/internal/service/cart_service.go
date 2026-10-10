package service

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/shopspring/decimal"

	"github.com/example/ecommerce-platform/services/cart/internal/domain"
	"github.com/example/ecommerce-platform/services/cart/internal/repository"
)

// CartService handles shopping cart operations
type CartService struct {
	cartRepo      *repository.CartRepository
	productClient ProductClient
	redisClient   *redis.Client
	cacheTTL      time.Duration
}

// ProductClient defines product service interface
type ProductClient interface {
	GetProduct(ctx context.Context, productID uuid.UUID) (*Product, error)
	CheckInventory(ctx context.Context, productID uuid.UUID, variantID *uuid.UUID, quantity int32) (bool, error)
}

// Product represents a product from the product service
type Product struct {
	ID        uuid.UUID
	Name      string
	SKU       string
	Price     decimal.Decimal
	Currency  string
	Inventory int32
	ImageURL  string
}

// NewCartService creates a new CartService
func NewCartService(
	cartRepo *repository.CartRepository,
	productClient ProductClient,
	redisClient *redis.Client,
) *CartService {
	return &CartService{
		cartRepo:      cartRepo,
		productClient: productClient,
		redisClient:   redisClient,
		cacheTTL:      30 * time.Minute,
	}
}

// GetCart retrieves a cart by user ID
func (s *CartService) GetCart(ctx context.Context, userID uuid.UUID) (*domain.Cart, error) {
	cacheKey := fmt.Sprintf("cart:%s", userID.String())
	cached, err := s.redisClient.Get(ctx, cacheKey).Result()
	if err == nil {
		var cart domain.Cart
		if err := json.Unmarshal([]byte(cached), &cart); err == nil {
			return &cart, nil
		}
	}

	cart, err := s.cartRepo.GetByUserID(ctx, userID)
	if err != nil {
		if err == domain.ErrCartNotFound {
			cart = &domain.Cart{
				ID:        uuid.New(),
				UserID:    userID,
				Items:     []domain.CartItem{},
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			}
			if err := s.cartRepo.Create(ctx, cart); err != nil {
				return nil, fmt.Errorf("creating cart: %w", err)
			}
		} else {
			return nil, fmt.Errorf("getting cart: %w", err)
		}
	}

	s.cacheCart(ctx, cart)

	return cart, nil
}

// AddItem adds an item to the cart
func (s *CartService) AddItem(
	ctx context.Context,
	userID uuid.UUID,
	productID uuid.UUID,
	variantID *uuid.UUID,
	quantity int32,
) (*domain.Cart, error) {
	product, err := s.productClient.GetProduct(ctx, productID)
	if err != nil {
		return nil, fmt.Errorf("getting product: %w", err)
	}

	available, err := s.productClient.CheckInventory(ctx, productID, variantID, quantity)
	if err != nil {
		return nil, fmt.Errorf("checking inventory: %w", err)
	}
	if !available {
		return nil, domain.ErrInsufficientInventory
	}

	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	found := false
	for i, item := range cart.Items {
		if item.ProductID == productID && compareUUIDs(item.VariantID, variantID) {
			cart.Items[i].Quantity += quantity
			cart.Items[i].TotalPrice = product.Price.Mul(decimal.NewFromInt32(cart.Items[i].Quantity))
			found = true
			break
		}
	}

	if !found {
		item := domain.CartItem{
			ID:          uuid.New(),
			ProductID:   productID,
			VariantID:   variantID,
			ProductName: product.Name,
			SKU:         product.SKU,
			Quantity:    quantity,
			UnitPrice:   product.Price,
			TotalPrice:  product.Price.Mul(decimal.NewFromInt32(quantity)),
			Currency:    product.Currency,
			ImageURL:    product.ImageURL,
		}
		cart.Items = append(cart.Items, item)
	}

	cart.CalculateTotal()
	cart.UpdatedAt = time.Now()

	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return nil, fmt.Errorf("updating cart: %w", err)
	}

	s.invalidateCache(ctx, userID)

	return cart, nil
}

// UpdateItemQuantity updates the quantity of a cart item
func (s *CartService) UpdateItemQuantity(
	ctx context.Context,
	userID uuid.UUID,
	itemID uuid.UUID,
	quantity int32,
) (*domain.Cart, error) {
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	found := false
	for i, item := range cart.Items {
		if item.ID == itemID {
			if quantity <= 0 {
				cart.Items = append(cart.Items[:i], cart.Items[i+1:]...)
			} else {
				available, err := s.productClient.CheckInventory(ctx, item.ProductID, item.VariantID, quantity)
				if err != nil {
					return nil, fmt.Errorf("checking inventory: %w", err)
				}
				if !available {
					return nil, domain.ErrInsufficientInventory
				}

				cart.Items[i].Quantity = quantity
				cart.Items[i].TotalPrice = item.UnitPrice.Mul(decimal.NewFromInt32(quantity))
			}
			found = true
			break
		}
	}

	if !found {
		return nil, domain.ErrItemNotFound
	}

	cart.CalculateTotal()
	cart.UpdatedAt = time.Now()

	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return nil, fmt.Errorf("updating cart: %w", err)
	}

	s.invalidateCache(ctx, userID)

	return cart, nil
}

// RemoveItem removes an item from the cart
func (s *CartService) RemoveItem(ctx context.Context, userID uuid.UUID, itemID uuid.UUID) (*domain.Cart, error) {
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	found := false
	for i, item := range cart.Items {
		if item.ID == itemID {
			cart.Items = append(cart.Items[:i], cart.Items[i+1:]...)
			found = true
			break
		}
	}

	if !found {
		return nil, domain.ErrItemNotFound
	}

	cart.CalculateTotal()
	cart.UpdatedAt = time.Now()

	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return nil, fmt.Errorf("updating cart: %w", err)
	}

	s.invalidateCache(ctx, userID)

	return cart, nil
}

// ClearCart clears all items from the cart
func (s *CartService) ClearCart(ctx context.Context, userID uuid.UUID) error {
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return fmt.Errorf("getting cart: %w", err)
	}

	cart.Items = []domain.CartItem{}
	cart.Subtotal = decimal.Zero
	cart.Tax = decimal.Zero
	cart.Total = decimal.Zero
	cart.UpdatedAt = time.Now()

	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return fmt.Errorf("updating cart: %w", err)
	}

	s.invalidateCache(ctx, userID)

	return nil
}

// ApplyCoupon applies a coupon to the cart
func (s *CartService) ApplyCoupon(ctx context.Context, userID uuid.UUID, couponCode string) (*domain.Cart, error) {
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	cart.CouponCode = couponCode
	cart.UpdatedAt = time.Now()

	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return nil, fmt.Errorf("updating cart: %w", err)
	}

	s.invalidateCache(ctx, userID)

	return cart, nil
}

func (s *CartService) cacheCart(ctx context.Context, cart *domain.Cart) {
	cacheKey := fmt.Sprintf("cart:%s", cart.UserID.String())
	data, err := json.Marshal(cart)
	if err != nil {
		return
	}
	s.redisClient.Set(ctx, cacheKey, data, s.cacheTTL)
}

func (s *CartService) invalidateCache(ctx context.Context, userID uuid.UUID) {
	cacheKey := fmt.Sprintf("cart:%s", userID.String())
	s.redisClient.Del(ctx, cacheKey)
}

func compareUUIDs(a, b *uuid.UUID) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}
