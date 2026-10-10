## Part 5: Cart Service

The Cart Service manages shopping carts with Redis for caching and PostgreSQL for persistence. Shopping carts are accessed very frequently but change often, which makes them an ideal candidate for a caching strategy where Redis serves as the fast primary store and PostgreSQL acts as the durable backup. This dual-storage approach means that even if the Redis cache is cleared or the server restarts, customers will not lose their cart contents. The service also handles merging anonymous carts with user accounts when a customer signs in.

### 5.1 Cart Service Implementation

**services/cart/internal/service/cart_service.go**

```go
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/shopspring/decimal"

	"github.com/yourusername/ecommerce/services/cart/internal/domain"
	"github.com/yourusername/ecommerce/services/cart/internal/repository"
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
	ID          uuid.UUID
	Name        string
	SKU         string
	Price       decimal.Decimal
	Currency    string
	Inventory   int32
	ImageURL    string
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
	// Try to get from cache first
	cacheKey := fmt.Sprintf("cart:%s", userID.String())
	cached, err := s.redisClient.Get(ctx, cacheKey).Result()
	if err == nil {
		var cart domain.Cart
		if err := json.Unmarshal([]byte(cached), &cart); err == nil {
			return &cart, nil
		}
	}

	// Get from database
	cart, err := s.cartRepo.GetByUserID(ctx, userID)
	if err != nil {
		if err == domain.ErrCartNotFound {
			// Create new cart
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

	// Cache the cart
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
	// Get product details
	product, err := s.productClient.GetProduct(ctx, productID)
	if err != nil {
		return nil, fmt.Errorf("getting product: %w", err)
	}

	// Check inventory
	available, err := s.productClient.CheckInventory(ctx, productID, variantID, quantity)
	if err != nil {
		return nil, fmt.Errorf("checking inventory: %w", err)
	}
	if !available {
		return nil, domain.ErrInsufficientInventory
	}

	// Get cart
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	// Check if item already exists
	found := false
	for i, item := range cart.Items {
		if item.ProductID == productID && compareUUIDs(item.VariantID, variantID) {
			// Update quantity
			cart.Items[i].Quantity += quantity
			cart.Items[i].TotalPrice = product.Price.Mul(decimal.NewFromInt32(cart.Items[i].Quantity))
			found = true
			break
		}
	}

	// Add new item if not found
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

	// Calculate totals
	cart.CalculateTotal()
	cart.UpdatedAt = time.Now()

	// Update in database
	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return nil, fmt.Errorf("updating cart: %w", err)
	}

	// Invalidate cache
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
	// Get cart
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	// Find and update item
	found := false
	for i, item := range cart.Items {
		if item.ID == itemID {
			if quantity <= 0 {
				// Remove item
				cart.Items = append(cart.Items[:i], cart.Items[i+1:]...)
			} else {
				// Check inventory
				available, err := s.productClient.CheckInventory(ctx, item.ProductID, item.VariantID, quantity)
				if err != nil {
					return nil, fmt.Errorf("checking inventory: %w", err)
				}
				if !available {
					return nil, domain.ErrInsufficientInventory
				}

				// Update quantity
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

	// Calculate totals
	cart.CalculateTotal()
	cart.UpdatedAt = time.Now()

	// Update in database
	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return nil, fmt.Errorf("updating cart: %w", err)
	}

	// Invalidate cache
	s.invalidateCache(ctx, userID)

	return cart, nil
}

// RemoveItem removes an item from the cart
func (s *CartService) RemoveItem(ctx context.Context, userID uuid.UUID, itemID uuid.UUID) (*domain.Cart, error) {
	// Get cart
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	// Find and remove item
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

	// Calculate totals
	cart.CalculateTotal()
	cart.UpdatedAt = time.Now()

	// Update in database
	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return nil, fmt.Errorf("updating cart: %w", err)
	}

	// Invalidate cache
	s.invalidateCache(ctx, userID)

	return cart, nil
}

// ClearCart clears all items from the cart
func (s *CartService) ClearCart(ctx context.Context, userID uuid.UUID) error {
	// Get cart
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return fmt.Errorf("getting cart: %w", err)
	}

	// Clear items
	cart.Items = []domain.CartItem{}
	cart.Subtotal = decimal.Zero
	cart.Tax = decimal.Zero
	cart.Total = decimal.Zero
	cart.UpdatedAt = time.Now()

	// Update in database
	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return fmt.Errorf("updating cart: %w", err)
	}

	// Invalidate cache
	s.invalidateCache(ctx, userID)

	return nil
}

// ApplyCoupon applies a coupon to the cart
func (s *CartService) ApplyCoupon(ctx context.Context, userID uuid.UUID, couponCode string) (*domain.Cart, error) {
	// Get cart
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	// Validate and apply coupon (simplified - would call coupon service in production)
	// For now, just store the coupon code
	cart.CouponCode = couponCode
	cart.UpdatedAt = time.Now()

	// Update in database
	if err := s.cartRepo.Update(ctx, cart); err != nil {
		return nil, fmt.Errorf("updating cart: %w", err)
	}

	// Invalidate cache
	s.invalidateCache(ctx, userID)

	return cart, nil
}

// Helper methods

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
```

---

### Junior → FAANG: Cart as a Caching Architecture Exercise

The dual-storage cart (Redis as fast primary, PostgreSQL as durable backup) is a practical caching pattern for state that is read frequently but can tolerate brief loss. For an interview, describe the read path (check Redis, fall back to PostgreSQL on miss, repopulate Redis) and the write path (write to both, or write to Redis first and sync to PostgreSQL asynchronously).

Anonymous cart merging (combining a guest cart with a user's authenticated cart at login) is a common interview follow-up. The merge strategy matters: if the same product is in both carts, do you sum the quantities or use the maximum? What if inventory is insufficient for the combined quantity? These product decisions drive the implementation logic.

Cart TTL is a business decision that has user experience implications. A 30-day cart TTL means users who return after a month find their cart preserved. A 7-day TTL means frequent abandoners see their carts expire, which reduces Redis memory usage but causes user frustration. Document the chosen TTL and the business rationale.

### Senior @ FAANG: Cart at Scale and Its Consistency Implications

At senior level, the cart service is a consistency domain. Prices in the cart can drift from current product prices: if a user adds an item at \$50 and the price changes to \$60 before checkout, which price applies? The business rule (price at add time versus price at checkout) has legal and user experience implications. The cart must either snapshot prices at add time (storing the price per cart item) or re-fetch prices at checkout. Both approaches have tradeoffs documented in the ADR.

Inventory consistency for cart operations is the hardest problem. Soft reservations (holding inventory when adding to cart) prevent overselling but can starve other customers if popular items sit in abandoned carts. Optimistic inventory (no reservation, check at checkout) allows overselling under concurrent load. The production answer depends on the product category: for limited-edition items (sneaker drops), soft reservations with short TTLs are required. For commodity items with large stock, optimistic checking is sufficient.

Redis persistence configuration for cart data requires thought. RDB snapshots (periodic full dumps) can lose up to `save` interval of cart data on crash. AOF persistence (write every operation to an append-only file) provides near-zero data loss but increases write latency. For cart data, AOF with `appendfsync everysec` (flush every second) is typically the right tradeoff: at most one second of cart updates lost on crash, with acceptable write latency overhead.

---
