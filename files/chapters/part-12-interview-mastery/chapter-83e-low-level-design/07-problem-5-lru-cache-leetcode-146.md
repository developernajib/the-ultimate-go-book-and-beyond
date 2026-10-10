## 83E.7 Problem 5: LRU Cache (LeetCode 146)

### Requirements

1. Get and Put operations in O(1)
2. Evict least recently used item when capacity is reached
3. Get marks the item as recently used

### Implementation

The LRU cache (LeetCode 146) is one of the most frequently asked data structure design problems, testing knowledge of hash map and doubly linked list composition for O(1) get and put operations. The following Go implementation demonstrates the combined data structure with clear separation between the indexing and ordering concerns.

```go
package lru

import "container/list"

type LRUCache struct {
	capacity int
	cache    map[int]*list.Element
	order    *list.List // front = most recent, back = least recent
}

type entry struct {
	key   int
	value int
}

func Constructor(capacity int) LRUCache {
	return LRUCache{
		capacity: capacity,
		cache:    make(map[int]*list.Element, capacity),
		order:    list.New(),
	}
}

func (lru *LRUCache) Get(key int) int {
	elem, exists := lru.cache[key]
	if !exists {
		return -1
	}
	lru.order.MoveToFront(elem)
	return elem.Value.(*entry).value
}

func (lru *LRUCache) Put(key int, value int) {
	if elem, exists := lru.cache[key]; exists {
		elem.Value.(*entry).value = value
		lru.order.MoveToFront(elem)
		return
	}

	if lru.order.Len() == lru.capacity {
		// Evict LRU (back of list)
		back := lru.order.Back()
		if back != nil {
			lru.order.Remove(back)
			delete(lru.cache, back.Value.(*entry).key)
		}
	}

	e := &entry{key: key, value: value}
	elem := lru.order.PushFront(e)
	lru.cache[key] = elem
}
```

**Complexity:** O(1) for both Get and Put.

### SOLID Analysis

- **S:** The cache handles storage and eviction - a single, cohesive responsibility.
- **O:** Could extract the eviction policy into an interface for LFU, FIFO, etc.
- **D:** Uses Go's `container/list` (a doubly-linked list) - could be swapped for a custom implementation.


### Junior → FAANG: LRU Cache LLD Basics

The LRU (Least Recently Used) cache requires O(1) get and put operations. The standard implementation combines a doubly-linked list (for O(1) removal from any position and O(1) insertion at the head) with a hash map (for O(1) lookup by key). On get: if the key exists, move the node to the head (most recently used) and return the value. On put: if the key exists, update the value and move to head. If it does not exist, insert at the head. If the capacity is exceeded, remove the tail node and the corresponding map entry. In Go, this requires a custom doubly-linked list struct (or adapter over container/list) and a map[int]*listNode.

### Senior @ FAANG: LRU Cache at the Senior Bar: Concurrency and Generics

At the senior level, the LRU cache LLD must address concurrency: a production LRU cache is accessed from multiple goroutines simultaneously. The naive approach wraps the entire cache in a sync.Mutex, which serializes all operations. A more sophisticated approach uses sharded caching (divide the key space into N shards, each with its own mutex) to reduce lock contention. In Go generics (1.18+), the LRU cache should be parameterized on the key and value types: Cache[K comparable, V any]. Senior candidates should also discuss the eviction policy extensibility: LRU is one policy, but LFU (Least Frequently Used) and ARC (Adaptive Replacement Cache) are alternatives for different access patterns. The policy should be behind an interface so the cache can switch eviction strategies without changing the client code.

---
