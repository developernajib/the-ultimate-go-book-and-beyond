// internal/store/store.go
package store

import (
	"container/list"
	"sync"
	"time"
)

type entry struct {
	key       string
	value     []byte
	expiresAt *time.Time
	element   *list.Element // For LRU
}

type Store struct {
	mu          sync.RWMutex
	data        map[string]*entry
	lru         *list.List
	maxMemory   int64
	currentSize int64
	stats       *Stats
}

type Stats struct {
	Hits      int64
	Misses    int64
	Evictions int64
	Keys      int64
}

func NewStore(maxMemory int64) *Store {
	s := &Store{
		data:      make(map[string]*entry),
		lru:       list.New(),
		maxMemory: maxMemory,
		stats:     &Stats{},
	}

	// Start expiration cleanup goroutine
	go s.cleanupExpired()

	return s
}

func (s *Store) Get(key string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, exists := s.data[key]
	if !exists {
		s.stats.Misses++
		return nil, false
	}

	// Check expiration
	if e.expiresAt != nil && time.Now().After(*e.expiresAt) {
		s.deleteEntry(key, e)
		s.stats.Misses++
		return nil, false
	}

	// Update LRU
	s.lru.MoveToFront(e.element)
	s.stats.Hits++

	return e.value, true
}

func (s *Store) Set(key string, value []byte, ttl *time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if key exists
	if e, exists := s.data[key]; exists {
		// Update existing entry
		s.currentSize -= int64(len(e.value))
		s.currentSize += int64(len(value))

		e.value = value
		if ttl != nil {
			expiresAt := time.Now().Add(*ttl)
			e.expiresAt = &expiresAt
		} else {
			e.expiresAt = nil
		}

		s.lru.MoveToFront(e.element)
	} else {
		// Create new entry
		newSize := s.currentSize + int64(len(key)) + int64(len(value))

		// Evict if necessary
		for newSize > s.maxMemory && s.lru.Len() > 0 {
			s.evictLRU()
			newSize = s.currentSize + int64(len(key)) + int64(len(value))
		}

		var expiresAt *time.Time
		if ttl != nil {
			exp := time.Now().Add(*ttl)
			expiresAt = &exp
		}

		elem := s.lru.PushFront(key)
		e := &entry{
			key:       key,
			value:     value,
			expiresAt: expiresAt,
			element:   elem,
		}

		s.data[key] = e
		s.currentSize += int64(len(key)) + int64(len(value))
		s.stats.Keys++
	}
}

func (s *Store) Delete(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, exists := s.data[key]
	if !exists {
		return false
	}

	s.deleteEntry(key, e)
	return true
}

func (s *Store) deleteEntry(key string, e *entry) {
	s.lru.Remove(e.element)
	delete(s.data, key)
	s.currentSize -= int64(len(key)) + int64(len(e.value))
	s.stats.Keys--
}

func (s *Store) evictLRU() {
	elem := s.lru.Back()
	if elem == nil {
		return
	}

	key := elem.Value.(string)
	e := s.data[key]
	s.deleteEntry(key, e)
	s.stats.Evictions++
}

func (s *Store) TTL(key string) (int64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	e, exists := s.data[key]
	if !exists {
		return -2, false // Key doesn't exist
	}

	if e.expiresAt == nil {
		return -1, true // No expiration
	}

	ttl := time.Until(*e.expiresAt)
	if ttl < 0 {
		return -2, false // Already expired
	}

	return int64(ttl.Seconds()), true
}

func (s *Store) Expire(key string, ttl time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, exists := s.data[key]
	if !exists {
		return false
	}

	expiresAt := time.Now().Add(ttl)
	e.expiresAt = &expiresAt
	return true
}

func (s *Store) cleanupExpired() {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		s.mu.Lock()

		now := time.Now()
		expired := make([]string, 0)

		// Collect expired keys (max 100 per cycle)
		count := 0
		for key, e := range s.data {
			if e.expiresAt != nil && now.After(*e.expiresAt) {
				expired = append(expired, key)
				count++
				if count >= 100 {
					break
				}
			}
		}

		// Delete expired keys
		for _, key := range expired {
			if e, exists := s.data[key]; exists {
				s.deleteEntry(key, e)
			}
		}

		s.mu.Unlock()
	}
}

func (s *Store) GetStats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return *s.stats
}

func (s *Store) Size() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.currentSize
}

func (s *Store) Keys() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	keys := make([]string, 0, len(s.data))
	for k := range s.data {
		keys = append(keys, k)
	}
	return keys
}
