// internal/util/cache/cache.go
package cache

import (
	"container/list"
	"sync"
)

// LRUCache implements a thread-safe LRU cache
type LRUCache struct {
	mu       sync.RWMutex
	capacity int
	items    map[string]*list.Element
	evict    *list.List
}

type entry struct {
	key   string
	value any
}

func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity: capacity,
		items:    make(map[string]*list.Element),
		evict:    list.New(),
	}
}

func (c *LRUCache) Get(key string) (any, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	elem, ok := c.items[key]
	if !ok {
		return nil, false
	}

	c.evict.MoveToFront(elem)
	return elem.Value.(*entry).value, true
}

func (c *LRUCache) Put(key string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		c.evict.MoveToFront(elem)
		elem.Value.(*entry).value = value
		return
	}

	elem := c.evict.PushFront(&entry{key: key, value: value})
	c.items[key] = elem

	if c.evict.Len() > c.capacity {
		oldest := c.evict.Back()
		if oldest != nil {
			c.evict.Remove(oldest)
			delete(c.items, oldest.Value.(*entry).key)
		}
	}
}

func (c *LRUCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.evict.Len()
}
