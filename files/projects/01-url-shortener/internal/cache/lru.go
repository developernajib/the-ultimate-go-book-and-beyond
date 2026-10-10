// internal/cache/lru.go
package cache

import (
	"container/list"
	"context"
	"sync"
	"time"

	"github.com/example/url-shortener/internal/models"
)

// LRUCache is an in-memory LRU cache
type LRUCache struct {
	capacity   int
	cache      map[string]*list.Element
	lruList    *list.List
	mu         sync.RWMutex
	defaultTTL time.Duration
}

// cacheEntry represents a cache entry
type cacheEntry struct {
	key       string
	url       *models.URL
	expiresAt time.Time
}

// NewLRUCache creates a new LRU cache
func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity:   capacity,
		cache:      make(map[string]*list.Element),
		lruList:    list.New(),
		defaultTTL: 1 * time.Hour,
	}
}

// Get retrieves a value from cache
func (c *LRUCache) Get(ctx context.Context, key string) (*models.URL, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	element, exists := c.cache[key]
	if !exists {
		return nil, nil // Cache miss
	}

	entry := element.Value.(*cacheEntry)

	// Check expiration
	if time.Now().After(entry.expiresAt) {
		c.removeElement(element)
		return nil, nil
	}

	// Move to front (most recently used)
	c.lruList.MoveToFront(element)

	return entry.url, nil
}

// Set stores a value in cache
func (c *LRUCache) Set(ctx context.Context, key string, url *models.URL, ttl time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if ttl == 0 {
		ttl = c.defaultTTL
	}

	// If key exists, update it
	if element, exists := c.cache[key]; exists {
		c.lruList.MoveToFront(element)
		entry := element.Value.(*cacheEntry)
		entry.url = url
		entry.expiresAt = time.Now().Add(ttl)
		return nil
	}

	// Add new entry
	entry := &cacheEntry{
		key:       key,
		url:       url,
		expiresAt: time.Now().Add(ttl),
	}

	element := c.lruList.PushFront(entry)
	c.cache[key] = element

	// Evict if over capacity
	if c.lruList.Len() > c.capacity {
		c.removeOldest()
	}

	return nil
}

// Delete removes a value from cache
func (c *LRUCache) Delete(ctx context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if element, exists := c.cache[key]; exists {
		c.removeElement(element)
	}

	return nil
}

// removeOldest removes the least recently used item
func (c *LRUCache) removeOldest() {
	element := c.lruList.Back()
	if element != nil {
		c.removeElement(element)
	}
}

// removeElement removes a specific element
func (c *LRUCache) removeElement(element *list.Element) {
	entry := element.Value.(*cacheEntry)
	delete(c.cache, entry.key)
	c.lruList.Remove(element)
}

// Size returns the current cache size
func (c *LRUCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.cache)
}
