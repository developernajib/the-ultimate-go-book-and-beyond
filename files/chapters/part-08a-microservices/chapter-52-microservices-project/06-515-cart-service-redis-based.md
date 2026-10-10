## 52.5 Cart Service (Redis-based)

The cart service stores shopping carts in Redis rather than PostgreSQL. Carts are ephemeral, accessed frequently, and benefit from Redis's sub-millisecond reads. Each cart is serialized as a single JSON value keyed by `cart:{userID}`, with a seven-day TTL. The trade-off is durability: if Redis loses data during a failover, carts are lost. In a production system, you would back carts with a database and use Redis as a cache (see the pitfalls section later in this chapter).

**Two Redis shapes to know.** A single JSON blob (what we use below) is the simplest option and works well when the whole cart is read and written together, which is the common access pattern. The alternative is a Redis Hash (`HSET cart:{userID} {productID} {quantity}`), which lets you add, update, and remove individual items without a read-modify-write cycle and supports atomic `HINCRBY` for quantity updates under contention. Pick the hash shape if you ever need to update line items from multiple tabs or devices concurrently. Pick JSON for simplicity otherwise.

**TTL extension and abandoned carts.** Every write below sets a fresh 7-day expiration, which implicitly "touches" the cart on activity. For abandonment recovery, emit a `cart.abandoned` event when a cart has been idle for N hours (a periodic scanner reading Redis keyspace notifications, or a ZSET indexed by last-activity timestamp) so the notification service can send a recovery email. Never rely on Redis key-expiration events as your only source of truth, they are best-effort and lost during failover.

```go
// internal/cart/service.go
package cart

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cart represents a shopping cart
type Cart struct {
	UserID    string     `json:"user_id"`
	Items     []CartItem `json:"items"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// CartItem represents an item in the cart
type CartItem struct {
	ProductID string  `json:"product_id"`
	Name      string  `json:"name"`
	PriceCents int64  `json:"price_cents"`
	Quantity  int     `json:"quantity"`
	ImageURL  string  `json:"image_url,omitempty"`
}

// Service handles cart operations
type Service struct {
	redis      *redis.Client
	expiration time.Duration
}

// NewService creates a cart service
func NewService(redisClient *redis.Client) *Service {
	return &Service{
		redis:      redisClient,
		expiration: 7 * 24 * time.Hour, // 7 days
	}
}

func (s *Service) cartKey(userID string) string {
	return fmt.Sprintf("cart:%s", userID)
}

// GetCart retrieves a user's cart
func (s *Service) GetCart(ctx context.Context, userID string) (*Cart, error) {
	data, err := s.redis.Get(ctx, s.cartKey(userID)).Bytes()
	if err == redis.Nil {
		return &Cart{
			UserID:    userID,
			Items:     []CartItem{},
			UpdatedAt: time.Now().UTC(),
		}, nil
	}
	if err != nil {
		return nil, err
	}

	var cart Cart
	if err := json.Unmarshal(data, &cart); err != nil {
		return nil, err
	}

	return &cart, nil
}

// AddItem adds an item to the cart
func (s *Service) AddItem(ctx context.Context, userID string, item CartItem) (*Cart, error) {
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, err
	}

	// Check if item exists
	found := false
	for i, existing := range cart.Items {
		if existing.ProductID == item.ProductID {
			cart.Items[i].Quantity += item.Quantity
			found = true
			break
		}
	}

	if !found {
		cart.Items = append(cart.Items, item)
	}

	cart.UpdatedAt = time.Now().UTC()

	return cart, s.saveCart(ctx, cart)
}

// UpdateItem updates an item quantity
func (s *Service) UpdateItem(ctx context.Context, userID, productID string, quantity int) (*Cart, error) {
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, err
	}

	if quantity <= 0 {
		return s.RemoveItem(ctx, userID, productID)
	}

	for i, item := range cart.Items {
		if item.ProductID == productID {
			cart.Items[i].Quantity = quantity
			cart.UpdatedAt = time.Now().UTC()
			return cart, s.saveCart(ctx, cart)
		}
	}

	return nil, ErrItemNotFound
}

// RemoveItem removes an item from the cart
func (s *Service) RemoveItem(ctx context.Context, userID, productID string) (*Cart, error) {
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return nil, err
	}

	for i, item := range cart.Items {
		if item.ProductID == productID {
			cart.Items = append(cart.Items[:i], cart.Items[i+1:]...)
			cart.UpdatedAt = time.Now().UTC()
			return cart, s.saveCart(ctx, cart)
		}
	}

	return cart, nil
}

// ClearCart removes all items from the cart
func (s *Service) ClearCart(ctx context.Context, userID string) error {
	return s.redis.Del(ctx, s.cartKey(userID)).Err()
}

// GetTotal calculates the cart total
func (s *Service) GetTotal(ctx context.Context, userID string) (int64, error) {
	cart, err := s.GetCart(ctx, userID)
	if err != nil {
		return 0, err
	}

	var totalCents int64
	for _, item := range cart.Items {
		totalCents += item.PriceCents * int64(item.Quantity)
	}

	return totalCents, nil
}

func (s *Service) saveCart(ctx context.Context, cart *Cart) error {
	data, err := json.Marshal(cart)
	if err != nil {
		return err
	}

	return s.redis.Set(ctx, s.cartKey(cart.UserID), data, s.expiration).Err()
}

// Errors
var (
	ErrItemNotFound = fmt.Errorf("item not found in cart")
)
```

### Junior → FAANG: Cart Service Trade-offs You Must Be Able to Articulate

The cart service is a common interview case study because it forces you to reason about the trade-off between speed and durability. Knowing the trade-off in the abstract is not enough. Be ready to name the concrete failure mode and the concrete mitigation.

**The Redis-only durability risk in plain language.** If the Redis primary fails before replication completes (Redis uses asynchronous replication by default), the last few seconds of writes are lost. For a cart, this means a user who added items and closed the browser comes back to a cart that is missing those items. If the entire Redis cluster fails (hardware failure, network partition), all carts are lost. This is not a theoretical risk. It happened to a major e-commerce company during a Black Friday failover and caused a measurable drop in conversion rate.

**The read-modify-write race condition.** `AddItem` reads the cart, modifies it in memory, and writes it back. Two concurrent requests (the user has two browser tabs open) can both read the same cart state, both add their item, and the second write overwrites the first. The result is a lost update. The fix is to use `WATCH`/`MULTI`/`EXEC` for optimistic locking in Redis, or switch to the Hash data structure with `HINCRBY` for quantity changes (which is atomic). For an interview, naming this race condition and its mitigation signals production experience.

**Why the TTL resets on every write.** `saveCart` calls `SET` with `s.expiration`, which resets the TTL to seven days from the current write. This means an active cart never expires. A cart that is last written seven days ago expires automatically. This is the intended behavior: abandoned carts disappear, active carts persist.

**First-job habit.** When you design any Redis-backed service, write down the answer to: "What user-visible behavior occurs if Redis is unavailable for 30 seconds? For 5 minutes? Permanently?" Have a mitigation for each scenario before the feature ships.

### Senior @ FAANG: Cart Architecture, Multi-Device Consistency, and the Database Backing Decision

The comments in this file describe the JSON blob vs Hash trade-off. The deeper question is the architectural position of the cart service: when does Redis as primary storage become inadequate, and what is the migration path?

**Multi-device cart merging.** A user adds items on mobile, then opens the desktop. Both sessions read the same Redis key, which is fine. But if the user is offline on mobile and adds items, then comes back online, there are two versions of the cart that must be merged. Redis gives you no help here. A conflict-free replicated data type (CRDT) model, where each item addition is a separate append-only event rather than a full cart replacement, handles offline merges correctly. This is more engineering than most cart services need, but it is the right model for a native mobile app with offline support.

**Guest cart to authenticated cart merging.** The current service assumes a user ID is always available. Real checkout flows have a guest cart (keyed by session token or device ID) that must be merged with an authenticated cart when the user logs in. The merge policy is a product decision: last-write wins, union of items, or interactive conflict resolution. The cart service must expose a `MergeCarts(guestID, userID)` endpoint, and the merge must be atomic (a Redis transaction or a database transaction) to prevent item duplication.

**Database backing as a platform standard.** The pitfalls section later in this chapter describes a real incident where Redis data loss caused a 40% conversion rate drop. At FAANG, the question of whether Redis is the primary store or the cache is not left to individual service teams. It is a platform governance decision: services that hold user-generated data with commercial value must have a persistent store as the source of truth. Redis may accelerate reads, but it is never the only copy. Establishing this as a policy before the first cart service is deployed prevents the incident pattern.

**Cart service as the checkout initiation point.** The cart service clears the cart when an order is created. But what if the checkout saga fails after the cart is cleared but before the order is confirmed? The user's cart is gone but they have no order. This is the "lost cart" failure mode. The robust design holds the cart in a "checkout in progress" state (not deleted, but locked against modification) until the saga either confirms or rolls back. Clearing the cart is the final step of the saga, not an early step.

---
