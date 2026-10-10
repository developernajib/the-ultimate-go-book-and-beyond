package cache

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// SearchCache is a thread-safe LRU-style cache for search results with TTL.
type SearchCache struct {
	mu      sync.RWMutex
	entries map[string]*cacheEntry
	ttl     time.Duration
	maxSize int
}

type cacheEntry struct {
	value     []byte
	expiresAt time.Time
}

// NewSearchCache creates a search result cache with the given TTL and max entry count.
func NewSearchCache(ttl time.Duration, maxSize int) *SearchCache {
	c := &SearchCache{
		entries: make(map[string]*cacheEntry),
		ttl:     ttl,
		maxSize: maxSize,
	}
	go c.evictLoop()
	return c
}

// Get retrieves a cached result by query key. Returns nil, false if not found or expired.
func (c *SearchCache) Get(query any) ([]byte, bool) {
	key := c.hashKey(query)
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.entries[key]
	if !ok || time.Now().After(entry.expiresAt) {
		return nil, false
	}
	return entry.value, true
}

// Set stores a result in the cache under the given query key.
func (c *SearchCache) Set(query any, value []byte) {
	key := c.hashKey(query)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= c.maxSize {
		c.evictOldest()
	}
	c.entries[key] = &cacheEntry{value: value, expiresAt: time.Now().Add(c.ttl)}
}

func (c *SearchCache) hashKey(query any) string {
	b, _ := json.Marshal(query)
	return fmt.Sprintf("%x", sha256.Sum256(b))
}

func (c *SearchCache) evictOldest() {
	var oldestKey string
	var oldestTime time.Time
	for k, v := range c.entries {
		if oldestKey == "" || v.expiresAt.Before(oldestTime) {
			oldestKey = k
			oldestTime = v.expiresAt
		}
	}
	delete(c.entries, oldestKey)
}

func (c *SearchCache) evictLoop() {
	ticker := time.NewTicker(c.ttl / 2)
	for range ticker.C {
		now := time.Now()
		c.mu.Lock()
		for k, v := range c.entries {
			if now.After(v.expiresAt) {
				delete(c.entries, k)
			}
		}
		c.mu.Unlock()
	}
}
