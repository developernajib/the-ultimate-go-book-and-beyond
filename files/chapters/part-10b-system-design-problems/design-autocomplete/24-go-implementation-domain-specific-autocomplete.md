## Go Implementation: Domain-Specific Autocomplete

Different domains require different autocomplete behavior. A web search suggestion returns just a text string, but a product search suggestion benefits from category labels, thumbnail images, and price hints. The DomainRouter directs each request to the appropriate trie, and domain-specific enrichment functions add metadata from external services like a product catalog.

```go
package autocomplete

import (
	"context"
	"fmt"
)

type Suggestion struct {
	Term  string
	Score float64
}

type Trie struct{}

type Product struct {
	Category      string
	ThumbnailURL  string
	MinPriceCents int64
}

type CatalogService interface {
	FindByName(ctx context.Context, name string) (*Product, error)
}

// DomainRouter routes suggestions to domain-specific tries
type DomainRouter struct {
	webTrie     *Trie
	productTrie *Trie
	userTrie    *Trie
}

// Route selects the appropriate trie based on domain
func (r *DomainRouter) Route(domain string) *Trie {
	switch domain {
	case "product":
		return r.productTrie
	case "user":
		return r.userTrie
	default:
		return r.webTrie
	}
}

// ProductSuggestion includes product-specific metadata
type ProductSuggestion struct {
	Term      string  `json:"term"`
	Score     float64 `json:"score"`
	Category  string  `json:"category,omitempty"`
	ImageURL  string  `json:"image_url,omitempty"`
	PriceHint string  `json:"price_hint,omitempty"` // "from $29.99"
}

// UserSuggestion includes user-specific metadata
type UserSuggestion struct {
	Username  string `json:"username"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	Verified  bool   `json:"verified"`
}

// Product search autocomplete enriches suggestions with catalog data
func enrichProductSuggestions(ctx context.Context, suggestions []Suggestion, catalogSvc CatalogService) []ProductSuggestion {
	var enriched []ProductSuggestion
	for _, s := range suggestions {
		ps := ProductSuggestion{Term: s.Term, Score: s.Score}

		// Look up in product catalog for metadata
		product, err := catalogSvc.FindByName(ctx, s.Term)
		if err == nil && product != nil {
			ps.Category = product.Category
			ps.ImageURL = product.ThumbnailURL
			// Prices are stored as integer cents, never float64
			ps.PriceHint = fmt.Sprintf("from $%d.%02d",
				product.MinPriceCents/100, product.MinPriceCents%100)
		}

		enriched = append(enriched, ps)
	}
	return enriched
}
```

---
