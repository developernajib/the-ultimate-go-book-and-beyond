// pkg/shortener/collision.go
package shortener

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
)

const maxRetries = 5

// CollisionResolver handles collision detection and resolution
type CollisionResolver struct {
	generator *Generator
	store     URLStore // Interface to check if code exists
}

// URLStore interface for checking code existence
type URLStore interface {
	CodeExists(ctx context.Context, code string) (bool, error)
}

// NewCollisionResolver creates a collision resolver
func NewCollisionResolver(store URLStore) *CollisionResolver {
	return &CollisionResolver{
		generator: NewGenerator(),
		store:     store,
	}
}

// ResolveCollision attempts to generate a unique code
func (r *CollisionResolver) ResolveCollision(ctx context.Context, baseCode string) (string, error) {
	for attempt := range maxRetries {
		// On first attempt, try the base code
		candidateCode := baseCode
		if attempt > 0 {
			// Add random suffix for subsequent attempts
			candidateCode = r.addRandomSuffix(baseCode)
		}

		exists, err := r.store.CodeExists(ctx, candidateCode)
		if err != nil {
			return "", fmt.Errorf("checking code existence: %w", err)
		}

		if !exists {
			return candidateCode, nil
		}
	}

	return "", fmt.Errorf("failed to resolve collision after %d attempts", maxRetries)
}

// addRandomSuffix adds a random character to the code
func (r *CollisionResolver) addRandomSuffix(code string) string {
	// Generate random number between 0-61
	n, _ := rand.Int(rand.Reader, big.NewInt(62))
	randomChar := base62Chars[n.Int64()]
	return code + string(randomChar)
}
