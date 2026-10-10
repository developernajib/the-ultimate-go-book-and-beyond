package cache

import (
	"context"
	"testing"
	"time"

	"github.com/example/url-shortener/internal/models"
)

func TestLRUCache_GetSetEvict(t *testing.T) {
	ctx := context.Background()
	c := NewLRUCache(2)

	u1 := &models.URL{ID: 1, ShortCode: "a", LongURL: "https://a.com"}
	u2 := &models.URL{ID: 2, ShortCode: "b", LongURL: "https://b.com"}
	u3 := &models.URL{ID: 3, ShortCode: "c", LongURL: "https://c.com"}

	_ = c.Set(ctx, "a", u1, time.Hour)
	_ = c.Set(ctx, "b", u2, time.Hour)

	if c.Size() != 2 {
		t.Fatalf("expected size 2, got %d", c.Size())
	}

	// Access "a" so "b" becomes the oldest
	gotA, err := c.Get(ctx, "a")
	if err != nil || gotA == nil || gotA.LongURL != "https://a.com" {
		t.Fatalf("failed to get 'a': %v, %v", gotA, err)
	}

	// Insert "c", which should evict "b"
	_ = c.Set(ctx, "c", u3, time.Hour)

	gotB, _ := c.Get(ctx, "b")
	if gotB != nil {
		t.Errorf("expected 'b' to be evicted, but got %v", gotB)
	}

	gotC, _ := c.Get(ctx, "c")
	if gotC == nil || gotC.LongURL != "https://c.com" {
		t.Errorf("expected 'c' to exist")
	}
}

func TestLRUCache_Expiration(t *testing.T) {
	ctx := context.Background()
	c := NewLRUCache(2)

	u := &models.URL{ID: 1, ShortCode: "exp", LongURL: "https://exp.com"}
	_ = c.Set(ctx, "exp", u, 10*time.Millisecond)

	time.Sleep(20 * time.Millisecond)

	got, err := c.Get(ctx, "exp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Fatalf("expected expired entry to be nil, got: %v", got)
	}
}
