## 69.9 Company Case Studies

### Twitter: Distributed User Session Store

A session store at social-network scale is a distributed hash table with TTLs. The sketch below is a representative shape of that pattern rather than any company's actual implementation:

```go
// Twitter-style distributed session store
// Uses consistent hashing for scalability
package sessions

import (
    "crypto/rand"
    "crypto/sha256"
    "encoding/binary"
    "encoding/hex"
    "sync"
    "time"
)

// Session represents a user session
type Session struct {
    UserID       string
    Token        string
    DeviceInfo   string
    IPAddress    string
    CreatedAt    time.Time
    ExpiresAt    time.Time
    LastActivity time.Time
    Data         map[string]any
}

// SessionStore manages user sessions with sharding
type SessionStore struct {
    shards     []*sessionShard
    numShards  int
    expiration time.Duration

    // For distributed deployment
    nodes     []string
    hashRing  *ConsistentHashRing
}

type sessionShard struct {
    sessions map[string]*Session
    mu       sync.RWMutex
}

// NewSessionStore creates a new session store
func NewSessionStore(numShards int, expiration time.Duration) *SessionStore {
    shards := make([]*sessionShard, numShards)
    for i := range shards {
        shards[i] = &sessionShard{
            sessions: make(map[string]*Session),
        }
    }

    return &SessionStore{
        shards:     shards,
        numShards:  numShards,
        expiration: expiration,
    }
}

// getShard returns the shard for a given token.
//
// Read 8 bytes of the digest, not 1: indexing on h[0] alone caps the reachable
// shard count at 256, so every shard past 255 would sit permanently empty.
func (s *SessionStore) getShard(token string) *sessionShard {
    h := sha256.Sum256([]byte(token))
    idx := binary.BigEndian.Uint64(h[:8]) % uint64(s.numShards)
    return s.shards[idx]
}

// Create creates a new session
func (s *SessionStore) Create(userID, deviceInfo, ipAddress string) *Session {
    token := generateSecureToken()

    session := &Session{
        UserID:       userID,
        Token:        token,
        DeviceInfo:   deviceInfo,
        IPAddress:    ipAddress,
        CreatedAt:    time.Now(),
        ExpiresAt:    time.Now().Add(s.expiration),
        LastActivity: time.Now(),
        Data:         make(map[string]any),
    }

    shard := s.getShard(token)
    shard.mu.Lock()
    shard.sessions[token] = session
    shard.mu.Unlock()

    return session
}

// Get retrieves a session by token
func (s *SessionStore) Get(token string) (*Session, bool) {
    shard := s.getShard(token)
    shard.mu.RLock()
    session, exists := shard.sessions[token]
    shard.mu.RUnlock()

    if !exists {
        return nil, false
    }

    // Check expiration
    if time.Now().After(session.ExpiresAt) {
        s.Delete(token)
        return nil, false
    }

    return session, true
}

// Refresh extends session expiration
func (s *SessionStore) Refresh(token string) bool {
    shard := s.getShard(token)
    shard.mu.Lock()
    defer shard.mu.Unlock()

    session, exists := shard.sessions[token]
    if !exists {
        return false
    }

    session.ExpiresAt = time.Now().Add(s.expiration)
    session.LastActivity = time.Now()
    return true
}

// Delete removes a session
func (s *SessionStore) Delete(token string) bool {
    shard := s.getShard(token)
    shard.mu.Lock()
    defer shard.mu.Unlock()

    if _, exists := shard.sessions[token]; !exists {
        return false
    }

    delete(shard.sessions, token)
    return true
}

// DeleteUserSessions removes all sessions for a user (logout all devices)
func (s *SessionStore) DeleteUserSessions(userID string) int {
    count := 0

    for _, shard := range s.shards {
        shard.mu.Lock()
        for token, session := range shard.sessions {
            if session.UserID == userID {
                delete(shard.sessions, token)
                count++
            }
        }
        shard.mu.Unlock()
    }

    return count
}

// CleanupExpired removes expired sessions
func (s *SessionStore) CleanupExpired() int {
    count := 0
    now := time.Now()

    for _, shard := range s.shards {
        shard.mu.Lock()
        for token, session := range shard.sessions {
            if now.After(session.ExpiresAt) {
                delete(shard.sessions, token)
                count++
            }
        }
        shard.mu.Unlock()
    }

    return count
}

// ConsistentHashRing for distributed deployment
type ConsistentHashRing struct {
    nodes       []string
    virtualNodes int
    ring        map[uint64]string
    sortedKeys  []uint64
    mu          sync.RWMutex
}

// generateSecureToken returns a 256-bit token from the OS CSPRNG.
//
// This MUST use crypto/rand, never math/rand. A session token is a bearer
// credential: anyone who can predict it can impersonate the user. Ignoring the
// error is safe here because crypto/rand.Read crashes the program irrecoverably
// rather than returning a short read, so it cannot silently hand back weak bytes.
func generateSecureToken() string {
    b := make([]byte, 32)
    rand.Read(b)
    return hex.EncodeToString(b)
}
```

### Spotify: Playlist Deduplication

Playlist deduplication is a textbook hash-set problem: membership checks must be O(1) because users import thousands of tracks at once. Again, this is the shape of the pattern, not a real internal design:

```go
// Spotify-style playlist management with deduplication
package playlist

import (
    "sync"
    "time"
)

// Track represents a music track
type Track struct {
    ID       string
    Title    string
    Artist   string
    Album    string
    Duration time.Duration
    URI      string
}

// Playlist manages tracks with deduplication
type Playlist struct {
    ID          string
    Name        string
    OwnerID     string
    Tracks      []*Track  // Ordered track list
    trackSet    map[string]int  // Track ID -> index for O(1) lookup
    totalDuration time.Duration

    mu sync.RWMutex
}

// NewPlaylist creates a new playlist
func NewPlaylist(id, name, ownerID string) *Playlist {
    return &Playlist{
        ID:       id,
        Name:     name,
        OwnerID:  ownerID,
        Tracks:   make([]*Track, 0),
        trackSet: make(map[string]int),
    }
}

// AddTrack adds a track if not duplicate
// Time: O(1) average
func (p *Playlist) AddTrack(track *Track) bool {
    p.mu.Lock()
    defer p.mu.Unlock()

    // Check for duplicate
    if _, exists := p.trackSet[track.ID]; exists {
        return false
    }

    // Add to ordered list and set
    p.trackSet[track.ID] = len(p.Tracks)
    p.Tracks = append(p.Tracks, track)
    p.totalDuration += track.Duration

    return true
}

// RemoveTrack removes a track by ID
// Time: O(1) average (using swap with last element)
func (p *Playlist) RemoveTrack(trackID string) bool {
    p.mu.Lock()
    defer p.mu.Unlock()

    idx, exists := p.trackSet[trackID]
    if !exists {
        return false
    }

    // Get track for duration update
    track := p.Tracks[idx]
    p.totalDuration -= track.Duration

    // Swap with last element for O(1) removal
    lastIdx := len(p.Tracks) - 1
    if idx != lastIdx {
        p.Tracks[idx] = p.Tracks[lastIdx]
        p.trackSet[p.Tracks[idx].ID] = idx
    }

    p.Tracks = p.Tracks[:lastIdx]
    delete(p.trackSet, trackID)

    return true
}

// Contains checks if a track is in the playlist
// Time: O(1)
func (p *Playlist) Contains(trackID string) bool {
    p.mu.RLock()
    defer p.mu.RUnlock()

    _, exists := p.trackSet[trackID]
    return exists
}

// Merge adds all tracks from another playlist (skipping duplicates)
func (p *Playlist) Merge(other *Playlist) int {
    p.mu.Lock()
    other.mu.RLock()
    defer p.mu.Unlock()
    defer other.mu.RUnlock()

    added := 0
    for _, track := range other.Tracks {
        if _, exists := p.trackSet[track.ID]; !exists {
            p.trackSet[track.ID] = len(p.Tracks)
            p.Tracks = append(p.Tracks, track)
            p.totalDuration += track.Duration
            added++
        }
    }

    return added
}

// Intersection returns tracks common to both playlists
func (p *Playlist) Intersection(other *Playlist) []*Track {
    p.mu.RLock()
    other.mu.RLock()
    defer p.mu.RUnlock()
    defer other.mu.RUnlock()

    var common []*Track

    // Use smaller set for iteration
    if len(p.trackSet) < len(other.trackSet) {
        for trackID := range p.trackSet {
            if _, exists := other.trackSet[trackID]; exists {
                common = append(common, p.Tracks[p.trackSet[trackID]])
            }
        }
    } else {
        for trackID := range other.trackSet {
            if idx, exists := p.trackSet[trackID]; exists {
                common = append(common, p.Tracks[idx])
            }
        }
    }

    return common
}

// Difference returns tracks in this playlist but not in other
func (p *Playlist) Difference(other *Playlist) []*Track {
    p.mu.RLock()
    other.mu.RLock()
    defer p.mu.RUnlock()
    defer other.mu.RUnlock()

    var diff []*Track
    for _, track := range p.Tracks {
        if _, exists := other.trackSet[track.ID]; !exists {
            diff = append(diff, track)
        }
    }

    return diff
}
```

### Cloudflare: DNS Cache

A DNS resolver cache is a hash table with a per-entry TTL supplied by the record itself. The code below shows the essential shape of that idea, simplified from what a production resolver does:

```go
// Cloudflare-style DNS cache with TTL
package dns

import (
    "sync"
    "time"
)

// DNSRecord represents a DNS record
type DNSRecord struct {
    Name      string
    Type      string  // A, AAAA, CNAME, MX, etc.
    Value     string
    TTL       time.Duration
    ExpiresAt time.Time
    Priority  int  // For MX records
}

// DNSCache implements a thread-safe DNS cache
type DNSCache struct {
    entries    map[string]map[string]*DNSRecord  // name -> type -> record
    mu         sync.RWMutex

    // LRU eviction
    maxEntries int
    accessList *accessNode
    accessTail *accessNode
    nodeMap    map[string]*accessNode
}

type accessNode struct {
    key  string
    prev *accessNode
    next *accessNode
}

// NewDNSCache creates a new DNS cache
func NewDNSCache(maxEntries int) *DNSCache {
    head := &accessNode{}
    tail := &accessNode{}
    head.next = tail
    tail.prev = head

    return &DNSCache{
        entries:    make(map[string]map[string]*DNSRecord),
        maxEntries: maxEntries,
        accessList: head,
        accessTail: tail,
        nodeMap:    make(map[string]*accessNode),
    }
}

// Get retrieves a DNS record
// Time: O(1)
func (c *DNSCache) Get(name, recordType string) (*DNSRecord, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    types, exists := c.entries[name]
    if !exists {
        return nil, false
    }

    record, exists := types[recordType]
    if !exists {
        return nil, false
    }

    // Check expiration
    if time.Now().After(record.ExpiresAt) {
        delete(types, recordType)
        if len(types) == 0 {
            delete(c.entries, name)
            c.removeFromLRU(name)
        }
        return nil, false
    }

    // Update LRU
    c.moveToFront(name)

    return record, true
}

// Set stores a DNS record
// Time: O(1)
func (c *DNSCache) Set(record *DNSRecord) {
    c.mu.Lock()
    defer c.mu.Unlock()

    key := record.Name

    // Check if we need to evict
    if _, exists := c.entries[key]; !exists && len(c.entries) >= c.maxEntries {
        c.evictLRU()
    }

    // Create record
    record.ExpiresAt = time.Now().Add(record.TTL)

    if c.entries[key] == nil {
        c.entries[key] = make(map[string]*DNSRecord)
        c.addToFront(key)
    }

    c.entries[key][record.Type] = record
    c.moveToFront(key)
}

// Prefetch refreshes a record before it expires
func (c *DNSCache) Prefetch(name, recordType string, resolver func(string, string) *DNSRecord) {
    c.mu.RLock()
    types, exists := c.entries[name]
    if !exists {
        c.mu.RUnlock()
        return
    }

    record, exists := types[recordType]
    if !exists {
        c.mu.RUnlock()
        return
    }

    // Prefetch when 75% of TTL has passed
    threshold := record.ExpiresAt.Add(-record.TTL / 4)
    c.mu.RUnlock()

    if time.Now().After(threshold) {
        // Async refresh
        go func() {
            newRecord := resolver(name, recordType)
            if newRecord != nil {
                c.Set(newRecord)
            }
        }()
    }
}

// LRU helper methods
func (c *DNSCache) addToFront(key string) {
    node := &accessNode{key: key}
    node.next = c.accessList.next
    node.prev = c.accessList
    c.accessList.next.prev = node
    c.accessList.next = node
    c.nodeMap[key] = node
}

func (c *DNSCache) moveToFront(key string) {
    node, exists := c.nodeMap[key]
    if !exists {
        return
    }

    // Remove from current position
    node.prev.next = node.next
    node.next.prev = node.prev

    // Add to front
    node.next = c.accessList.next
    node.prev = c.accessList
    c.accessList.next.prev = node
    c.accessList.next = node
}

func (c *DNSCache) removeFromLRU(key string) {
    node, exists := c.nodeMap[key]
    if !exists {
        return
    }

    node.prev.next = node.next
    node.next.prev = node.prev
    delete(c.nodeMap, key)
}

func (c *DNSCache) evictLRU() {
    // Get LRU entry (right before tail)
    lru := c.accessTail.prev
    if lru == c.accessList {
        return
    }

    delete(c.entries, lru.key)
    c.removeFromLRU(lru.key)
}
```

### Junior -> FAANG: Reading Production Code to Build Interview Intuition

These three case studies (Twitter session store, Spotify playlist, Cloudflare DNS cache) are production-grade examples of patterns you will be asked to implement or design in interviews. From each, extract one mental model.

Twitter session store: session tokens are hashed to a shard using SHA-256 to ensure uniform distribution across shards. The shard-based locking allows thousands of concurrent session operations without a single global lock. The `CleanupExpired` scan is a background goroutine pattern, not an inline operation, because scanning all shards synchronously on every request would be O(n) per operation.

Spotify playlist: the `trackSet map[string]int` (track ID to slice index) is the same trick used in the RandomizedSet problem. Order is maintained by the slice. O(1) lookup and deletion are provided by the map. The two structures are always kept in sync, which is a correctness invariant that must be maintained atomically under concurrent access.

Cloudflare DNS cache: the prefetch pattern (refresh at 75% of TTL lifetime) is a standard cache warming technique that prevents the "stale miss" problem where a popular cache entry expires and causes a latency spike on the first miss. The goroutine-based async refresh ensures the prefetch does not block the hot path.

### Senior @ FAANG: Architectural Critique of the Case Studies

Each case study has production limitations that a staff engineer would identify in a design review.

The session store's shard selection is worth studying as a bug you will meet in real code. An earlier form of `getShard` read `int(h[0]) % numShards`, taking a single byte of the digest. SHA-256 output is uniform, so one byte is uniform too, and the code looks fine in review and in tests. It fails only past 256 shards, where `h[0]` cannot produce an index above 255 and every higher shard sits permanently empty while the first 256 absorb the entire load. The version above reads `binary.BigEndian.Uint64(h[:8])` instead. Two lessons generalize: a truncated hash silently caps the key space it can address, and a bug that only appears above a scaling threshold will not show up until the day you scale past it.

Strictly, `% numShards` still carries modulo bias unless the shard count divides the hash range evenly. With a 64-bit value the skew is far too small to matter for load balancing. It matters enormously if you ever reuse this pattern to select a *secret* rather than a shard, which is why `crypto/rand.Int` exists.

A second, deeper limitation: the store shards but does not distribute. `numShards` is fixed at construction, so changing it rehashes every token and logs out every user at once. That is exactly the O(n) migration problem consistent hashing solves, and it is why the `ConsistentHashRing` field is stubbed here rather than left out.

The Spotify `Merge` function acquires locks on both playlists in a fixed order (self then other). If two goroutines call `p1.Merge(p2)` and `p2.Merge(p1)` concurrently, the code will deadlock. The canonical fix is to establish a global lock ordering (for example, by comparing pointer addresses) and always acquire the lower-address lock first. `Intersection` has the same shape, and additionally deadlocks against a concurrent writer if a caller ever passes a playlist to itself. Documenting this ordering requirement in the API contract is as important as implementing it.

`RemoveTrack` hides a subtler defect, and it is a domain bug rather than a concurrency one. `Tracks` is documented as an ordered track list, but the O(1) removal trick swaps the last track into the vacated slot, so deleting one song silently reorders the playlist. The swap-with-last idiom is correct for `RandomizedSet`, where the collection is explicitly unordered, and wrong here, where order is the user-visible product. Preserving order costs an O(n) `slices.Delete` plus an O(n) reindex of every shifted entry. The lesson is that a complexity win is only a win if it preserves the invariants the caller actually depends on, and "it is O(1)" is not a defense when the feature is a playlist.

The Cloudflare DNS cache's `Prefetch` reads the record under `mu.RLock()`, then releases the lock and spawns a goroutine. Between the lock release and the goroutine execution, another goroutine could delete the record. The spawned goroutine will then call `Set` for a record that should no longer exist. The fix requires either checking the record's existence again inside the goroutine under a write lock, or using a version counter to detect stale prefetch operations.

---
