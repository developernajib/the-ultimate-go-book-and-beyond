## 52B.8 Domain Services

### When to Use Domain Services

A **Domain Service** encapsulates business logic that does not naturally belong to a single entity or value object. Use a domain service when:

- The logic involves multiple aggregates
- The logic is a significant domain operation that domain experts would name
- Placing the logic in an entity would create an unnatural dependency

Domain services are **stateless**. They receive domain objects, perform logic, and return results or modify the passed objects.

The `PricingService` below illustrates a domain service that calculates order totals with discount policies. Pricing depends on the order's lines, the customer's loyalty tier, and potentially external promotion rules, so it does not belong in the `Order` entity itself.

```go
// domain/order/pricing_service.go

package order

// PricingService calculates order pricing applying business rules.
// This is a domain service because pricing logic involves multiple domain concepts
// (products, discount policies, customer tiers) that don't belong in Order alone.
type PricingService struct {
    discountPolicy DiscountPolicy
}

// DiscountPolicy is a domain interface for discount calculation.
// Different bounded contexts (promotion engine) can provide implementations.
type DiscountPolicy interface {
    // CalculateDiscount returns the discount Money for an order.
    CalculateDiscount(order *Order, customerTier CustomerTier) (Money, error)
}

// CustomerTier represents the customer's loyalty tier.
type CustomerTier string

const (
    CustomerTierStandard  CustomerTier = "standard"
    CustomerTierPremium   CustomerTier = "premium"
    CustomerTierEnterprise CustomerTier = "enterprise"
)

// NewPricingService creates a new PricingService.
func NewPricingService(policy DiscountPolicy) *PricingService {
    return &PricingService{discountPolicy: policy}
}

// PricedOrder represents the result of pricing an order.
type PricedOrder struct {
    SubTotal Money
    Discount Money
    Total    Money
}

// PriceOrder applies discount policies to an order and returns the final pricing.
func (s *PricingService) PriceOrder(order *Order, tier CustomerTier) (PricedOrder, error) {
    subtotal := order.TotalAmount()

    discount, err := s.discountPolicy.CalculateDiscount(order, tier)
    if err != nil {
        return PricedOrder{}, err
    }

    total, err := subtotal.Subtract(discount)
    if err != nil {
        return PricedOrder{}, err
    }

    if total.Amount < 0 {
        total.Amount = 0
    }

    return PricedOrder{
        SubTotal: subtotal,
        Discount: discount,
        Total:    total,
    }, nil
}
```

### Junior → FAANG: Knowing When to Create a Domain Service

The diagnostic question for a domain service is: "Does this operation belong naturally to a single entity, or does it coordinate multiple domain objects in a way that no single entity should own?"

If the operation only needs data from one entity and modifies only that entity's state, it belongs on the entity. `Order.Cancel()` is the canonical example: it only needs the order's current state, and it modifies only the order. No domain service needed.

If the operation involves two entities from different aggregates, it belongs in a domain service. `PricingService.PriceOrder(order, customerTier)` needs the order's lines and the customer's tier, which comes from a different context. Putting that logic on `Order.Price(tier)` would require `Order` to know about customer tiers, coupling two separate concepts.

A common first-job mistake is creating a domain service for every operation involving more than one field. A domain service is not just "a function that takes multiple arguments." It represents a significant domain operation that domain experts would recognize and name. "Price an order with a discount" is a named operation in the business. "Get the first line of an order" is not.

For interviews, if asked to name an operation that should be a domain service in a given domain, pick one that involves clearly separate aggregate data and that has a name a business person would use without being prompted. Bonus points for noting that domain services are stateless (they receive their inputs, compute a result, and return it, with no side effects stored in the service object itself).

### Senior @ FAANG: Domain Service Interface Design and Cross-Context Dependency Management

Domain services become architecturally significant at the point where they must reach across a bounded context boundary to complete their operation.

**Domain services that depend on external context data.** The `PricingService` needs the customer's loyalty tier, which lives in the Customer or Loyalty bounded context. The correct design: define a `CustomerTierLookup` interface in the Order bounded context's domain package. The infrastructure layer provides an implementation that calls the Loyalty service's API or reads from a locally cached projection. The domain service depends on the interface, not on any HTTP client or gRPC stub. This preserves the dependency rule: domain depends on nothing external.

**Statelessness as a testability guarantee.** A domain service that stores state (a cache, a running total, a counter) is implicitly coupled to the lifecycle of the request that created it, and it produces test isolation problems because tests that run concurrently share state. Senior engineers enforce statelessness in code review by rejecting any domain service that has mutable fields. If caching is needed for performance, it belongs in the infrastructure adapter that implements the interface the domain service depends on, not in the domain service itself.

**Domain services vs. application services: the common confusion at L5.** The distinction that separates L5 from L6 candidates is where coordination logic lives. An application service orchestrates: load from repository, call domain service or aggregate method, save to repository, publish events. A domain service encapsulates: business logic that spans multiple domain objects but belongs in the domain layer. If a method in your "domain service" is loading aggregates from repositories or publishing events, it is actually an application service masquerading as a domain service. This is a real code smell in complex codebases, and naming it precisely in a code review or system design discussion signals L6-level architectural thinking.

**Putting domain service logic in the right context.** When pricing logic involves multiple bounded contexts (Order, Inventory, Promotion, Loyalty), the question of which context owns the `PricingService` is a design decision with governance implications. The Core Domain for a commerce company is usually Pricing or Orders. If Pricing is its own bounded context, it exports a `PricingGateway` interface (Open Host Service) that other contexts consume. If Pricing is a subdomain within the Orders context, the `PricingService` lives in the Orders domain package. Getting this wrong creates either a god service that everything depends on (too centralized) or a pricing logic split across five services with no single owner (too distributed). At the L6 bar, you are expected to make this placement decision explicitly and justify it in terms of subdomain type (Core/Supporting/Generic) and team ownership.

---
