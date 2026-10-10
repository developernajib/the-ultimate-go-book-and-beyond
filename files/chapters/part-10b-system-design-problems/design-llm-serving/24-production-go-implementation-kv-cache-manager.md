## Production Go Implementation: KV Cache Manager

This production-quality KV cache manager implements PagedAttention-style memory management for LLM serving, enabling efficient GPU memory utilization across concurrent requests. It maintains a pool of fixed-size memory blocks (similar to OS memory pages) and assigns them to inference sequences on demand. The manager also supports copy-on-write for beam search (where multiple candidate sequences share common prefix blocks) and integrates a prompt cache that stores pre-computed KV states for frequently reused system prompts. When GPU memory runs low, the eviction logic removes the least-recently-used prompt cache entries first before rejecting new requests.

```go
package kvcache

import (
	"container/list"
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// --- KV Cache Types ---

// BlockSize is the number of tokens per KV cache block.
// Matching vLLM's default of 16 tokens per block.
const BlockSize = 16

// Block represents a fixed-size chunk of GPU memory holding KV cache data.
// Instead of pre-allocating contiguous memory per request (wasteful),
// we use paged allocation like virtual memory.
type Block struct {
	ID          int32
	TokenCount  int32      // number of tokens stored (0 to BlockSize)
	RefCount    int32      // number of sequences sharing this block (copy-on-write)
	LastAccess  time.Time
	LayerID     int        // which transformer layer
	Data        []float32  // actual KV cache tensor data (on GPU in production)
}

// IsEmpty checks if the block has no tokens.
func (b *Block) IsEmpty() bool {
	return atomic.LoadInt32(&b.TokenCount) == 0
}

// IsFull checks if the block has reached capacity.
func (b *Block) IsFull() bool {
	return atomic.LoadInt32(&b.TokenCount) >= int32(BlockSize)
}

// IsShared checks if multiple sequences reference this block (copy-on-write).
func (b *Block) IsShared() bool {
	return atomic.LoadInt32(&b.RefCount) > 1
}

// --- Block Table (per sequence) ---

// BlockTable maps logical block indices to physical blocks for a sequence.
// Similar to a page table in virtual memory management.
type BlockTable struct {
	SequenceID string
	Blocks     []*Block  // ordered list of blocks for this sequence
	NumTokens  int32     // total tokens stored across all blocks
}

// LogicalToPhysical translates a token position to its physical block.
func (bt *BlockTable) LogicalToPhysical(tokenIdx int) (*Block, int) {
	blockIdx := tokenIdx / BlockSize
	offsetInBlock := tokenIdx % BlockSize
	if blockIdx >= len(bt.Blocks) {
		return nil, 0
	}
	return bt.Blocks[blockIdx], offsetInBlock
}

// --- KV Cache Manager ---

// CacheManager manages GPU memory allocation for KV caches using paged attention.
// It maintains a pool of fixed-size blocks and allocates them on demand.
type CacheManager struct {
	totalBlocks   int
	freeBlocks    *list.List       // pool of free blocks
	blockTables   map[string]*BlockTable // sequence ID -> block table
	allBlocks     []*Block         // all blocks (indexed by ID)
	mu            sync.Mutex

	// Prompt cache: reuse KV cache for common prompt prefixes
	promptCache   map[uint64]*PromptCacheEntry // hash -> cached blocks
	promptCacheMu sync.RWMutex

	// Metrics
	allocatedBlocks int64
	cacheHits       int64
	cacheMisses     int64
	evictions       int64
}

// PromptCacheEntry stores pre-computed KV cache for a prompt prefix.
type PromptCacheEntry struct {
	Hash       uint64
	Blocks     []*Block
	TokenCount int32
	HitCount   int64
	LastHit    time.Time
	CreatedAt  time.Time
}

// NewCacheManager creates a KV cache manager with the given GPU memory budget.
// gpuMemoryBytes is the total GPU memory available for KV cache.
// bytesPerBlock is the memory required per block (depends on model dims).
func NewCacheManager(gpuMemoryBytes int64, bytesPerBlock int64) *CacheManager {
	totalBlocks := int(gpuMemoryBytes / bytesPerBlock)

	cm := &CacheManager{
		totalBlocks: totalBlocks,
		freeBlocks:  list.New(),
		blockTables: make(map[string]*BlockTable),
		allBlocks:   make([]*Block, totalBlocks),
		promptCache: make(map[uint64]*PromptCacheEntry),
	}

	// Initialize block pool
	for i := 0; i < totalBlocks; i++ {
		block := &Block{
			ID:       int32(i),
			RefCount: 0,
			Data:     make([]float32, BlockSize*256), // placeholder for actual GPU tensor
		}
		cm.allBlocks[i] = block
		cm.freeBlocks.PushBack(block)
	}

	return cm
}

// AllocateSequence creates a new block table for a sequence.
func (cm *CacheManager) AllocateSequence(ctx context.Context, seqID string) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	if _, exists := cm.blockTables[seqID]; exists {
		return fmt.Errorf("sequence already exists: %s", seqID)
	}

	cm.blockTables[seqID] = &BlockTable{
		SequenceID: seqID,
		Blocks:     make([]*Block, 0, 8),
	}
	return nil
}

// AppendToken allocates space for a new token in the sequence's KV cache.
// Returns the physical block and offset where the token's KV data should be written.
func (cm *CacheManager) AppendToken(ctx context.Context, seqID string) (*Block, int, error) {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	bt, exists := cm.blockTables[seqID]
	if !exists {
		return nil, 0, fmt.Errorf("sequence not found: %s", seqID)
	}

	// Check if current last block has space
	var currentBlock *Block
	if len(bt.Blocks) > 0 {
		currentBlock = bt.Blocks[len(bt.Blocks)-1]
	}

	if currentBlock == nil || currentBlock.IsFull() {
		// Need a new block
		block, err := cm.allocateBlock()
		if err != nil {
			return nil, 0, fmt.Errorf("out of GPU memory: %w", err)
		}
		bt.Blocks = append(bt.Blocks, block)
		currentBlock = block
	}

	// If block is shared (copy-on-write), make a private copy
	if currentBlock.IsShared() {
		newBlock, err := cm.copyOnWrite(currentBlock)
		if err != nil {
			return nil, 0, err
		}
		bt.Blocks[len(bt.Blocks)-1] = newBlock
		currentBlock = newBlock
	}

	offset := int(atomic.AddInt32(&currentBlock.TokenCount, 1) - 1)
	bt.NumTokens++
	currentBlock.LastAccess = time.Now()

	return currentBlock, offset, nil
}

// FreeSequence releases all blocks associated with a sequence.
func (cm *CacheManager) FreeSequence(ctx context.Context, seqID string) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	bt, exists := cm.blockTables[seqID]
	if !exists {
		return fmt.Errorf("sequence not found: %s", seqID)
	}

	for _, block := range bt.Blocks {
		newRef := atomic.AddInt32(&block.RefCount, -1)
		if newRef <= 0 {
			// Block is no longer referenced, return to pool
			block.TokenCount = 0
			block.RefCount = 0
			cm.freeBlocks.PushBack(block)
			atomic.AddInt64(&cm.allocatedBlocks, -1)
		}
	}

	delete(cm.blockTables, seqID)
	return nil
}

// ForkSequence creates a new sequence that shares KV cache blocks with the parent.
// This is used for beam search and parallel sampling - the forked sequence
// shares all existing blocks (copy-on-write) and only allocates new blocks
// for diverging tokens.
func (cm *CacheManager) ForkSequence(ctx context.Context, parentID, childID string) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	parentBT, exists := cm.blockTables[parentID]
	if !exists {
		return fmt.Errorf("parent sequence not found: %s", parentID)
	}

	childBT := &BlockTable{
		SequenceID: childID,
		Blocks:     make([]*Block, len(parentBT.Blocks)),
		NumTokens:  parentBT.NumTokens,
	}

	// Share blocks (copy-on-write)
	for i, block := range parentBT.Blocks {
		atomic.AddInt32(&block.RefCount, 1) // increment ref count
		childBT.Blocks[i] = block
	}

	cm.blockTables[childID] = childBT
	return nil
}

// TryPromptCache checks if KV cache for a prompt prefix is already computed.
// cm.mu is held for the whole operation: eviction also needs cm.mu, so the
// entry cannot be evicted between the lookup and the ref count increments.
func (cm *CacheManager) TryPromptCache(ctx context.Context, seqID string, promptHash uint64) (int32, bool) {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	cm.promptCacheMu.RLock()
	entry, exists := cm.promptCache[promptHash]
	cm.promptCacheMu.RUnlock()

	if !exists {
		atomic.AddInt64(&cm.cacheMisses, 1)
		return 0, false
	}

	bt, btExists := cm.blockTables[seqID]
	if !btExists {
		return 0, false
	}

	// Share cached blocks with this sequence (copy-on-write)
	for _, block := range entry.Blocks {
		atomic.AddInt32(&block.RefCount, 1)
		bt.Blocks = append(bt.Blocks, block)
	}
	bt.NumTokens = entry.TokenCount

	atomic.AddInt64(&entry.HitCount, 1)
	entry.LastHit = time.Now()
	atomic.AddInt64(&cm.cacheHits, 1)

	return entry.TokenCount, true
}

// SavePromptCache stores computed KV cache blocks for future reuse.
func (cm *CacheManager) SavePromptCache(ctx context.Context, seqID string, promptHash uint64) error {
	cm.mu.Lock()
	bt, exists := cm.blockTables[seqID]
	if !exists {
		cm.mu.Unlock()
		return fmt.Errorf("sequence not found: %s", seqID)
	}

	// Clone block references
	blocks := make([]*Block, len(bt.Blocks))
	for i, block := range bt.Blocks {
		atomic.AddInt32(&block.RefCount, 1)
		blocks[i] = block
	}
	tokenCount := bt.NumTokens
	cm.mu.Unlock()

	entry := &PromptCacheEntry{
		Hash:       promptHash,
		Blocks:     blocks,
		TokenCount: tokenCount,
		CreatedAt:  time.Now(),
		LastHit:    time.Now(),
	}

	cm.promptCacheMu.Lock()
	cm.promptCache[promptHash] = entry
	cm.promptCacheMu.Unlock()

	return nil
}

// EvictPromptCache removes least-recently-used prompt cache entries.
func (cm *CacheManager) EvictPromptCache(ctx context.Context, targetFreeBlocks int) int {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	return cm.evictPromptCacheLocked(targetFreeBlocks)
}

// evictPromptCacheLocked requires cm.mu to be held. Lock order is always
// cm.mu before promptCacheMu, so the allocation path (which already holds
// cm.mu) can evict without releasing its lock and without deadlock.
func (cm *CacheManager) evictPromptCacheLocked(targetFreeBlocks int) int {
	cm.promptCacheMu.Lock()
	defer cm.promptCacheMu.Unlock()

	evicted := 0
	// Simple LRU: find and remove oldest entries until we have enough free blocks
	for cm.freeBlocks.Len() < targetFreeBlocks && len(cm.promptCache) > 0 {
		var oldestHash uint64
		var oldestTime time.Time
		first := true

		for hash, entry := range cm.promptCache {
			if first || entry.LastHit.Before(oldestTime) {
				oldestHash = hash
				oldestTime = entry.LastHit
				first = false
			}
		}

		entry := cm.promptCache[oldestHash]
		for _, block := range entry.Blocks {
			newRef := atomic.AddInt32(&block.RefCount, -1)
			if newRef <= 0 {
				block.TokenCount = 0
				block.RefCount = 0
				cm.freeBlocks.PushBack(block)
				atomic.AddInt64(&cm.allocatedBlocks, -1)
			}
		}

		delete(cm.promptCache, oldestHash)
		evicted++
		atomic.AddInt64(&cm.evictions, 1)
	}

	return evicted
}

// Stats returns current cache manager statistics.
func (cm *CacheManager) Stats() CacheStats {
	cm.mu.Lock()
	allocated := int(atomic.LoadInt64(&cm.allocatedBlocks))
	free := cm.freeBlocks.Len()
	sequences := len(cm.blockTables)
	cm.mu.Unlock()

	cm.promptCacheMu.RLock()
	promptEntries := len(cm.promptCache)
	cm.promptCacheMu.RUnlock()

	return CacheStats{
		TotalBlocks:      cm.totalBlocks,
		AllocatedBlocks:  allocated,
		FreeBlocks:       free,
		ActiveSequences:  sequences,
		PromptCacheSize:  promptEntries,
		PromptCacheHits:  atomic.LoadInt64(&cm.cacheHits),
		PromptCacheMisses: atomic.LoadInt64(&cm.cacheMisses),
		Evictions:        atomic.LoadInt64(&cm.evictions),
		UtilizationPct:   float64(allocated) / float64(cm.totalBlocks) * 100,
	}
}

type CacheStats struct {
	TotalBlocks       int     `json:"total_blocks"`
	AllocatedBlocks   int     `json:"allocated_blocks"`
	FreeBlocks        int     `json:"free_blocks"`
	ActiveSequences   int     `json:"active_sequences"`
	PromptCacheSize   int     `json:"prompt_cache_size"`
	PromptCacheHits   int64   `json:"prompt_cache_hits"`
	PromptCacheMisses int64   `json:"prompt_cache_misses"`
	Evictions         int64   `json:"evictions"`
	UtilizationPct    float64 `json:"utilization_pct"`
}

// --- Internal helpers ---

// allocateBlock requires cm.mu to be held by the caller.
func (cm *CacheManager) allocateBlock() (*Block, error) {
	if cm.freeBlocks.Len() == 0 {
		// Try evicting prompt cache entries first, without releasing cm.mu
		evicted := cm.evictPromptCacheLocked(10)
		if evicted == 0 || cm.freeBlocks.Len() == 0 {
			return nil, fmt.Errorf("no free blocks (total=%d, all allocated)", cm.totalBlocks)
		}
	}

	elem := cm.freeBlocks.Front()
	cm.freeBlocks.Remove(elem)
	block := elem.Value.(*Block)
	block.TokenCount = 0
	block.RefCount = 1
	block.LastAccess = time.Now()
	atomic.AddInt64(&cm.allocatedBlocks, 1)
	return block, nil
}

func (cm *CacheManager) copyOnWrite(src *Block) (*Block, error) {
	newBlock, err := cm.allocateBlock()
	if err != nil {
		return nil, err
	}

	// Copy data from source block
	copy(newBlock.Data, src.Data)
	newBlock.TokenCount = src.TokenCount
	newBlock.RefCount = 1

	// Decrement source ref count
	atomic.AddInt32(&src.RefCount, -1)

	return newBlock, nil
}
```

---
