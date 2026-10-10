## Deduplication

Content-addressable storage using chunk hashes:

```go
package storage

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
)

// ChunkStore stores unique chunks by content hash
type ChunkStore struct {
    storage ObjectStorage // S3 or similar
    index   ChunkIndex    // Hash -> storage location
}

// StoreChunk stores a chunk, returning its hash
// If chunk already exists, returns existing hash without storing
func (s *ChunkStore) StoreChunk(ctx context.Context, data []byte) (string, error) {
    // Calculate content hash
    hash := sha256.Sum256(data)
    hashStr := hex.EncodeToString(hash[:])

    // Check if already exists (deduplication)
    exists, err := s.index.Exists(ctx, hashStr)
    if err != nil {
        return "", err
    }

    if exists {
        return hashStr, nil // Already stored, skip upload
    }

    // Store new chunk
    location := fmt.Sprintf("chunks/%s/%s", hashStr[:2], hashStr)
    if err := s.storage.Put(ctx, location, data); err != nil {
        return "", err
    }

    // Update index
    if err := s.index.Set(ctx, hashStr, location); err != nil {
        return "", err
    }

    return hashStr, nil
}

// Deduplication saves significant storage
// If 1000 users have the same PDF, we store it once
```


### Junior → FAANG: Content Deduplication Basics

Deduplication means storing identical data only once. The mechanism: hash the chunk content (SHA-256 is common), look up the hash in a chunk registry, and if it already exists, just add a reference rather than storing again. This gives content-addressed storage: the storage key is a function of the content, which also enables corruption detection. The interview entry point is explaining why content-addressed storage is preferable to UUID-keyed storage for a file sync system: automatic deduplication and built-in integrity verification.

### Senior @ FAANG: Deduplication Governance, Security, and Cross-User Privacy

At the senior level, deduplication introduces a subtle privacy concern: cross-user deduplication means two users who upload the same file share the same underlying storage block. This creates a timing side-channel that has been exploited in practice (a user can detect whether a file already exists in the system by observing that a duplicate upload returns instantly). The mitigation is per-user or per-namespace deduplication, which sacrifices some storage efficiency for privacy isolation. This is an explicit ADR decision: the trade-off between storage cost reduction and information leakage risk. At the staff level, deduplication also interacts with encryption at rest: if chunks are encrypted with a per-user key, cross-user deduplication is no longer possible because the same plaintext content produces different ciphertexts. Convergent encryption (derive the encryption key from the content hash) re-enables deduplication but creates a known-plaintext attack surface. These are the kinds of security-design trade-offs that bar-raisers at L6/L7 will probe in depth.
