// pkg/shortener/generator.go
package shortener

import (
	"crypto/md5"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var (
	ErrInvalidAlias           = errors.New("invalid alias: must be 3-20 alphanumeric characters")
	ErrInvalidBase62Character = errors.New("invalid base62 character")
	ErrAliasAlreadyExists     = errors.New("alias already exists")
)

// Generator handles short code generation
type Generator struct {
	minLength int
	maxLength int
}

// NewGenerator creates a new code generator
func NewGenerator() *Generator {
	return &Generator{
		minLength: 6,
		maxLength: 10,
	}
}

// GenerateFromID creates a short code from an auto-incrementing ID
// This is deterministic and collision-free
func (g *Generator) GenerateFromID(id uint64) string {
	encoded := Encode(id)

	// Pad to minimum length if needed
	if len(encoded) < g.minLength {
		padding := strings.Repeat("0", g.minLength-len(encoded))
		return padding + encoded
	}

	return encoded
}

// GenerateFromURL creates a short code by hashing the URL
// This may have collisions but is consistent for the same URL
func (g *Generator) GenerateFromURL(url string) string {
	hash := md5.Sum([]byte(url))

	// Take first 8 bytes and convert to uint64
	num := binary.BigEndian.Uint64(hash[:8])

	encoded := Encode(num)

	// Take first 7 characters
	if len(encoded) > 7 {
		return encoded[:7]
	}

	return encoded
}

// ValidateCustomAlias validates a user-provided alias
func (g *Generator) ValidateCustomAlias(alias string) error {
	if len(alias) < 3 || len(alias) > 20 {
		return ErrInvalidAlias
	}

	// Only allow alphanumeric, hyphens, and underscores
	matched, _ := regexp.MatchString(`^[a-zA-Z0-9_-]+$`, alias)
	if !matched {
		return ErrInvalidAlias
	}

	// Reserved words that shouldn't be used as aliases
	reserved := map[string]bool{
		"api": true, "admin": true, "dashboard": true,
		"stats": true, "health": true, "metrics": true,
	}

	if reserved[strings.ToLower(alias)] {
		return fmt.Errorf("%w: alias is reserved", ErrInvalidAlias)
	}

	return nil
}
