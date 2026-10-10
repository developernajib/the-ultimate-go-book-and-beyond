// pkg/shortener/base62.go
package shortener

import (
	"strings"
)

const (
	// Base62 character set (62 characters)
	base62Chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	base        = 62
)

// Encode converts a uint64 to a Base62 string
func Encode(num uint64) string {
	if num == 0 {
		return string(base62Chars[0])
	}

	var result strings.Builder
	for num > 0 {
		remainder := num % base
		result.WriteByte(base62Chars[remainder])
		num = num / base
	}

	// Reverse the string (since we built it backwards)
	encoded := result.String()
	return reverse(encoded)
}

// Decode converts a Base62 string to uint64
func Decode(encoded string) (uint64, error) {
	var num uint64
	for _, char := range encoded {
		pos := strings.IndexRune(base62Chars, char)
		if pos == -1 {
			return 0, ErrInvalidBase62Character
		}
		num = num*uint64(base) + uint64(pos) // Horner's method: avoid math.Pow
	}

	return num, nil
}

// reverse reverses a string
func reverse(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
