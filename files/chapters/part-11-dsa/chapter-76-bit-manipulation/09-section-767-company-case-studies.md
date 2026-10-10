## 76.7 Company Case Studies

### Google: Feature Flag System with Bit Fields

Feature flag systems at large companies pack flags into bit fields because evaluating a flag must cost nanoseconds, not a map lookup:

```go
package featureflags

import (
    "math/bits"
    "sync"
    "sync/atomic"
)

// FeatureFlags represents a set of feature flags stored as bits
type FeatureFlags uint64

const (
    FeatureSearch FeatureFlags = 1 << iota // Bit 0
    FeatureAds                             // Bit 1
    FeatureMaps                            // Bit 2
    FeaturePhotos                          // Bit 3
    FeatureDrive                           // Bit 4
    FeatureGmail                           // Bit 5
    FeatureCalendar                        // Bit 6
    FeatureMeet                            // Bit 7
    FeatureChat                            // Bit 8
    FeatureDocs                            // Bit 9
    FeatureSheets                          // Bit 10
    FeatureSlides                          // Bit 11
    FeatureYouTube                         // Bit 12
    FeatureCloud                           // Bit 13
    FeatureAssistant                       // Bit 14
    FeatureTranslate                       // Bit 15
    // Can store up to 64 features in a single uint64
)

// FeatureFlagService manages feature flags for users
type FeatureFlagService struct {
    userFlags sync.Map // map[userID]FeatureFlags
    defaults  atomic.Uint64
}

// NewFeatureFlagService creates a new feature flag service
func NewFeatureFlagService(defaults FeatureFlags) *FeatureFlagService {
    s := &FeatureFlagService{}
    s.defaults.Store(uint64(defaults))
    return s
}

// EnableFeature enables a feature for a user
func (s *FeatureFlagService) EnableFeature(userID string, feature FeatureFlags) {
    for {
        current, _ := s.userFlags.LoadOrStore(userID, s.getDefaults())
        flags := current.(FeatureFlags)
        newFlags := flags | feature // Set bit using OR
        if s.userFlags.CompareAndSwap(userID, flags, newFlags) {
            return
        }
    }
}

// DisableFeature disables a feature for a user
func (s *FeatureFlagService) DisableFeature(userID string, feature FeatureFlags) {
    for {
        current, _ := s.userFlags.LoadOrStore(userID, s.getDefaults())
        flags := current.(FeatureFlags)
        newFlags := flags &^ feature // Clear bit using AND NOT
        if s.userFlags.CompareAndSwap(userID, flags, newFlags) {
            return
        }
    }
}

// ToggleFeature toggles a feature for a user
func (s *FeatureFlagService) ToggleFeature(userID string, feature FeatureFlags) {
    for {
        current, _ := s.userFlags.LoadOrStore(userID, s.getDefaults())
        flags := current.(FeatureFlags)
        newFlags := flags ^ feature // Toggle bit using XOR
        if s.userFlags.CompareAndSwap(userID, flags, newFlags) {
            return
        }
    }
}

// HasFeature checks if a user has a feature enabled
func (s *FeatureFlagService) HasFeature(userID string, feature FeatureFlags) bool {
    current, ok := s.userFlags.Load(userID)
    if !ok {
        return s.getDefaults()&feature != 0
    }
    return current.(FeatureFlags)&feature != 0
}

// HasAllFeatures checks if user has all specified features
func (s *FeatureFlagService) HasAllFeatures(userID string, features FeatureFlags) bool {
    current, ok := s.userFlags.Load(userID)
    if !ok {
        return s.getDefaults()&features == features
    }
    return current.(FeatureFlags)&features == features
}

// HasAnyFeature checks if user has any of specified features
func (s *FeatureFlagService) HasAnyFeature(userID string, features FeatureFlags) bool {
    current, ok := s.userFlags.Load(userID)
    if !ok {
        return s.getDefaults()&features != 0
    }
    return current.(FeatureFlags)&features != 0
}

// GetEnabledFeatures returns list of enabled feature names
func (s *FeatureFlagService) GetEnabledFeatures(userID string) []string {
    flags, ok := s.userFlags.Load(userID)
    if !ok {
        flags = s.getDefaults()
    }

    featureNames := map[FeatureFlags]string{
        FeatureSearch:    "search",
        FeatureAds:       "ads",
        FeatureMaps:      "maps",
        FeaturePhotos:    "photos",
        FeatureDrive:     "drive",
        FeatureGmail:     "gmail",
        FeatureCalendar:  "calendar",
        FeatureMeet:      "meet",
        FeatureChat:      "chat",
        FeatureDocs:      "docs",
        FeatureSheets:    "sheets",
        FeatureSlides:    "slides",
        FeatureYouTube:   "youtube",
        FeatureCloud:     "cloud",
        FeatureAssistant: "assistant",
        FeatureTranslate: "translate",
    }

    var enabled []string
    f := flags.(FeatureFlags)
    for feature, name := range featureNames {
        if f&feature != 0 {
            enabled = append(enabled, name)
        }
    }
    return enabled
}

// CountEnabledFeatures counts enabled features using bit counting
func (s *FeatureFlagService) CountEnabledFeatures(userID string) int {
    flags, ok := s.userFlags.Load(userID)
    if !ok {
        flags = s.getDefaults()
    }
    // Use the standard library rather than a hand-written loop. Brian
    // Kernighan's n &= n-1 trick is worth understanding and not worth shipping.
    return bits.OnesCount64(uint64(flags.(FeatureFlags)))
}

func (s *FeatureFlagService) getDefaults() FeatureFlags {
    return FeatureFlags(s.defaults.Load())
}
```

### Amazon: Permission System with Bitmasks

Permission systems are the canonical production use of bitmasks: one integer per principal, one bit per capability:

```go
package permissions

import (
    "fmt"
)

// Permission represents a single permission bit
type Permission uint32

const (
    PermRead Permission = 1 << iota  // 1
    PermWrite                        // 2
    PermDelete                       // 4
    PermCreate                       // 8
    PermExecute                      // 16
    PermShare                        // 32
    PermAdmin                        // 64
    PermOwner                        // 128
    PermAudit                        // 256
    PermExport                       // 512
    PermImport                       // 1024
    PermApprove                      // 2048
    PermReject                       // 4096
    PermDelegate                     // 8192
    PermEncrypt                      // 16384
    PermDecrypt                      // 32768
)

// Common permission combinations
const (
    PermReadOnly   = PermRead
    PermReadWrite  = PermRead | PermWrite
    PermFullAccess = PermRead | PermWrite | PermDelete | PermCreate
    PermAdminFull  = PermFullAccess | PermAdmin | PermShare | PermAudit
    PermOwnerFull  = PermAdminFull | PermOwner | PermDelegate
)

// ResourcePermissions manages permissions for resources
type ResourcePermissions struct {
    userPerms     map[string]map[string]Permission // userID -> resourceID -> permissions
    rolePerms     map[string]Permission            // roleID -> permissions
    userRoles     map[string][]string              // userID -> roleIDs
    resourceOwner map[string]string                // resourceID -> ownerID
}

// NewResourcePermissions creates a new permission manager
func NewResourcePermissions() *ResourcePermissions {
    return &ResourcePermissions{
        userPerms:     make(map[string]map[string]Permission),
        rolePerms:     make(map[string]Permission),
        userRoles:     make(map[string][]string),
        resourceOwner: make(map[string]string),
    }
}

// DefineRole creates a role with specific permissions
func (rp *ResourcePermissions) DefineRole(roleID string, perms Permission) {
    rp.rolePerms[roleID] = perms
}

// AssignRole assigns a role to a user
func (rp *ResourcePermissions) AssignRole(userID, roleID string) {
    rp.userRoles[userID] = append(rp.userRoles[userID], roleID)
}

// SetOwner sets the owner of a resource
func (rp *ResourcePermissions) SetOwner(resourceID, userID string) {
    rp.resourceOwner[resourceID] = userID
}

// GrantPermission grants permissions on a resource to a user
func (rp *ResourcePermissions) GrantPermission(userID, resourceID string, perms Permission) {
    if rp.userPerms[userID] == nil {
        rp.userPerms[userID] = make(map[string]Permission)
    }
    rp.userPerms[userID][resourceID] |= perms // Add permissions using OR
}

// RevokePermission revokes permissions from a user
func (rp *ResourcePermissions) RevokePermission(userID, resourceID string, perms Permission) {
    if rp.userPerms[userID] != nil {
        rp.userPerms[userID][resourceID] &^= perms // Remove using AND NOT
    }
}

// GetEffectivePermissions returns all effective permissions for a user on a resource
func (rp *ResourcePermissions) GetEffectivePermissions(userID, resourceID string) Permission {
    var effective Permission

    // Check if user is owner (gets all permissions)
    if owner, ok := rp.resourceOwner[resourceID]; ok && owner == userID {
        return PermOwnerFull
    }

    // Add role-based permissions
    for _, roleID := range rp.userRoles[userID] {
        if perms, ok := rp.rolePerms[roleID]; ok {
            effective |= perms
        }
    }

    // Add direct permissions
    if userResources, ok := rp.userPerms[userID]; ok {
        if perms, ok := userResources[resourceID]; ok {
            effective |= perms
        }
    }

    return effective
}

// HasPermission checks if user has specific permission
func (rp *ResourcePermissions) HasPermission(userID, resourceID string, perm Permission) bool {
    effective := rp.GetEffectivePermissions(userID, resourceID)
    return effective&perm == perm
}

// HasAllPermissions checks if user has all specified permissions
func (rp *ResourcePermissions) HasAllPermissions(userID, resourceID string, perms Permission) bool {
    effective := rp.GetEffectivePermissions(userID, resourceID)
    return effective&perms == perms
}

// HasAnyPermission checks if user has any of specified permissions
func (rp *ResourcePermissions) HasAnyPermission(userID, resourceID string, perms Permission) bool {
    effective := rp.GetEffectivePermissions(userID, resourceID)
    return effective&perms != 0
}

// FormatPermissions returns human-readable permission string
func (rp *ResourcePermissions) FormatPermissions(perms Permission) string {
    names := []struct {
        perm Permission
        name string
    }{
        {PermRead, "read"}, {PermWrite, "write"}, {PermDelete, "delete"},
        {PermCreate, "create"}, {PermExecute, "execute"}, {PermShare, "share"},
        {PermAdmin, "admin"}, {PermOwner, "owner"}, {PermAudit, "audit"},
        {PermExport, "export"}, {PermImport, "import"}, {PermApprove, "approve"},
        {PermReject, "reject"}, {PermDelegate, "delegate"},
        {PermEncrypt, "encrypt"}, {PermDecrypt, "decrypt"},
    }

    var result string
    for _, n := range names {
        if perms&n.perm != 0 {
            if result != "" {
                result += ", "
            }
            result += n.name
        }
    }
    return fmt.Sprintf("[%s]", result)
}
```

### Netflix: Bloom Filter for Content Deduplication

Bloom filters, bit arrays behind k hash functions, are the standard answer to "have we seen this before?" at streaming-catalog scale:

```go
package bloom

import (
    "hash/fnv"
    "math"
    "math/bits"
    "sync"
)

// BloomFilter is a probabilistic data structure for set membership
type BloomFilter struct {
    bits    []uint64 // Bit array stored as uint64 slices
    size    uint64   // Number of bits
    numHash int      // Number of hash functions
    mu      sync.RWMutex
}

// NewBloomFilter creates a bloom filter sized for the expected item count and
// target false positive rate.
//
// Use math.Log. Do not hand-roll the natural log here. An earlier version of
// this code used the three-term Mercator series
//
//     (x-1) - (x-1)^2/2 + (x-1)^3/3
//
// which converges only near x = 1 and is badly wrong at the small p values a
// Bloom filter actually uses. At p = 0.001 it returns -1.83 instead of -6.91,
// so the filter allocates 3.8x too few bits and picks k = 2 instead of 9. The
// measured false positive rate lands near 17%, not the 0.1% requested. It
// still compiles, still runs, and still returns plausible-looking answers.
// That is the whole danger: a numeric bug in a sizing formula is invisible
// until someone measures the thing it was supposed to guarantee.
func NewBloomFilter(expectedItems int, falsePositiveRate float64) *BloomFilter {
    if expectedItems <= 0 {
        expectedItems = 1
    }
    if falsePositiveRate <= 0 || falsePositiveRate >= 1 {
        falsePositiveRate = 0.01
    }

    // Optimal size: m = -n*ln(p) / (ln(2)^2)
    m := uint64(float64(-expectedItems) * math.Log(falsePositiveRate) / (math.Ln2 * math.Ln2))
    if m == 0 {
        m = 1 // Guard: size is a modulus below, and 0 would panic.
    }

    // Optimal number of hash functions: k = (m/n) * ln(2)
    k := int(float64(m) / float64(expectedItems) * math.Ln2)
    if k < 1 {
        k = 1
    }

    // Round up to a whole number of 64-bit words.
    numWords := (m + 63) / 64

    return &BloomFilter{
        bits:    make([]uint64, numWords),
        size:    m,
        numHash: k,
    }
}

// Add adds an item to the bloom filter
func (bf *BloomFilter) Add(item []byte) {
    bf.mu.Lock()
    defer bf.mu.Unlock()

    h1, h2 := bf.hash(item)
    for i := 0; i < bf.numHash; i++ {
        pos := (h1 + uint64(i)*h2) % bf.size
        bf.setBit(pos)
    }
}

// Contains checks if item might be in the set (may have false positives)
func (bf *BloomFilter) Contains(item []byte) bool {
    bf.mu.RLock()
    defer bf.mu.RUnlock()

    h1, h2 := bf.hash(item)
    for i := 0; i < bf.numHash; i++ {
        pos := (h1 + uint64(i)*h2) % bf.size
        if !bf.getBit(pos) {
            return false
        }
    }
    return true
}

// setBit sets the bit at position pos
func (bf *BloomFilter) setBit(pos uint64) {
    wordIdx := pos / 64
    bitIdx := pos % 64
    bf.bits[wordIdx] |= 1 << bitIdx
}

// getBit returns true if bit at position pos is set
func (bf *BloomFilter) getBit(pos uint64) bool {
    wordIdx := pos / 64
    bitIdx := pos % 64
    return bf.bits[wordIdx]&(1<<bitIdx) != 0
}

// hash generates two hash values using double hashing technique
func (bf *BloomFilter) hash(item []byte) (uint64, uint64) {
    h := fnv.New128()
    h.Write(item)
    sum := h.Sum(nil)

    h1 := uint64(sum[0])<<56 | uint64(sum[1])<<48 | uint64(sum[2])<<40 |
        uint64(sum[3])<<32 | uint64(sum[4])<<24 | uint64(sum[5])<<16 |
        uint64(sum[6])<<8 | uint64(sum[7])
    h2 := uint64(sum[8])<<56 | uint64(sum[9])<<48 | uint64(sum[10])<<40 |
        uint64(sum[11])<<32 | uint64(sum[12])<<24 | uint64(sum[13])<<16 |
        uint64(sum[14])<<8 | uint64(sum[15])

    return h1, h2
}

// EstimatedFillRatio returns the estimated fill ratio
func (bf *BloomFilter) EstimatedFillRatio() float64 {
    bf.mu.RLock()
    defer bf.mu.RUnlock()

    setBits := 0
    for _, word := range bf.bits {
        // bits.OnesCount64 is the right call, not a hand-rolled SWAR sequence.
        // The compiler lowers it to POPCNT where the target supports it, and to
        // a well-tuned fallback where it does not. The classic parallel-bit-
        // counting version is correct but strictly worse: more code, no faster,
        // and one typo away from silently wrong.
        setBits += bits.OnesCount64(word)
    }
    return float64(setBits) / float64(bf.size)
}

// ContentDeduplicator uses bloom filter for efficient content deduplication
type ContentDeduplicator struct {
    filter    *BloomFilter
    confirmed map[string]struct{} // Confirmed duplicates
    mu        sync.RWMutex
}

// NewContentDeduplicator creates a content deduplicator
func NewContentDeduplicator(expectedContent int) *ContentDeduplicator {
    return &ContentDeduplicator{
        filter:    NewBloomFilter(expectedContent, 0.001), // 0.1% false positive rate
        confirmed: make(map[string]struct{}),
    }
}

// AddContent adds content hash to the deduplicator
func (cd *ContentDeduplicator) AddContent(contentHash string) {
    cd.filter.Add([]byte(contentHash))
}

// IsPotentialDuplicate checks if content might be a duplicate
func (cd *ContentDeduplicator) IsPotentialDuplicate(contentHash string) bool {
    return cd.filter.Contains([]byte(contentHash))
}

// ConfirmDuplicate marks content as confirmed duplicate
func (cd *ContentDeduplicator) ConfirmDuplicate(contentHash string) {
    cd.mu.Lock()
    defer cd.mu.Unlock()
    cd.confirmed[contentHash] = struct{}{}
}

// IsConfirmedDuplicate checks if content is confirmed duplicate
func (cd *ContentDeduplicator) IsConfirmedDuplicate(contentHash string) bool {
    cd.mu.RLock()
    defer cd.mu.RUnlock()
    _, ok := cd.confirmed[contentHash]
    return ok
}
```

### Junior -> FAANG: Reading Production Code as a Learning Signal

The three case studies above (Google feature flags, Amazon permissions, Netflix Bloom filter) share a common structure: a bitmask type alias with `iota` constants, atomic or mutex-protected read-modify-write, and a set of typed predicate methods (`HasFeature`, `HasPermission`). This structure is the correct production pattern. Study it and replicate it in your own projects. The type alias prevents passing a raw integer where a flag set is expected. The `iota` constants prevent duplicate bit assignments. The predicate methods prevent callers from writing raw bitmask expressions in business logic.

Notice the `CountEnabledFeatures` function: it calls `popcount` rather than iterating over each bit. This is the correct approach. If you ever find yourself writing a loop that counts bits by right-shifting, replace it with `math/bits.OnesCount`.

The Bloom filter implementation includes a fill ratio metric via `EstimatedFillRatio`. This is an important production habit: every data structure that has a capacity or saturation point should expose a metric for it. Without this, you will not know when to resize.

### Senior @ FAANG: Governing Bitmask Systems at Scale

The feature flag case study shows a single `uint64` holding up to 64 flags per user. This design has a hard ceiling, and the natural question is what happens when a product team adds the 65th feature.

Here Go is kinder than the folklore suggests, and it is worth checking rather than repeating the warning. Adding a 65th `iota` constant does **not** silently wrap to zero. The constant expression `1 << 64` is evaluated in arbitrary precision at compile time and then must fit its declared type, so the build fails outright:

```
cannot use 1 << iota (untyped int constant 18446744073709551616)
    as FeatureFlags value in constant declaration (overflows)
```

Untyped constants are exact in Go, so the 65th flag is a compile error and no guard is needed to catch it. This is one of the places where Go's constant rules quietly prevent a bug class that C leaves to the programmer.

Distinguish that from the *runtime* case, which is where the zero comes from. `1 << i` with a variable `i == 64` is not an error and evaluates to 0, because Go defines over-wide shifts as yielding zero rather than as undefined behaviour. So code that computes a bit position dynamically can silently produce an all-zeros mask, and that path deserves a bounds check. The constant path does not.

Be wary of "compile-time guards" written from memory rather than tested. A construct like

```
var _ [1]struct{} = [uint64(FeatureTranslate) >> 63]struct{}{}
```

looks like an assertion but is simply broken: for any flag below bit 63 the shift yields 0, making this `[0]struct{}` assigned to `[1]struct{}`, which fails to compile in exactly the healthy case it was meant to permit. If you want a real static assertion in Go, the idiomatic form is a constant expression that underflows an unsigned type when the invariant is violated:

```
// Sketch. Fails to compile once highestFlagBit exceeds 63, because the
// subtraction would go negative and a uint constant cannot be negative.
const _ uint = 63 - highestFlagBit
```

The general lesson outranks the specific fix: an assertion you have never seen fail, and never seen pass, is decoration. Test the guard by deliberately breaking the invariant once and confirming the build actually goes red. And in this particular case, check whether you need the guard at all before writing one, since Go already rejects the 65th constant on its own.

The Amazon permission system's `GetEffectivePermissions` function computes effective rights by ORing role permissions with direct permissions. A senior engineer will immediately ask: "what is the deny model?" Standard RBAC with only grants cannot express "this user has admin role but is explicitly denied delete on this resource." If the product requires explicit denies, the permission model needs a separate deny bitmask, and the effective permission computation becomes `(rolePerm | directPerm) &^ denyPerm`. Adding deny masks after the fact is a significant migration. Raise this question in the design review before the first user is onboarded.

The Bloom filter's sizing formula deserves the closest scrutiny in this section, because it is where a plausible-looking shortcut does the most damage. An earlier version of this code hand-rolled the natural log as a three-term Mercator series. That series converges only near x = 1, and the sizing formula evaluates it at the false positive rate, typically 0.001, which is nowhere near 1. At p = 0.001 it returns -1.83 against a true value of -6.91.

Follow the consequences through, because this is the point. The filter allocates 3.8x fewer bits than required and selects k = 2 hash functions instead of 9. Nothing crashes. `Add` and `Contains` behave normally. The structure simply delivers a measured false positive rate near 17% while its constructor's documentation promises 0.1%, a miss of more than two orders of magnitude. Downstream, a deduplicator built on it starts discarding distinct content as duplicates, and the resulting data loss looks like an application bug, far from the arithmetic that caused it.

The review rule this justifies: numerical shortcuts are not local. Use `math.Log`, which is correctly rounded and costs nothing here since sizing runs once per filter. Reserve hand-written approximations for cases with profiler evidence and an explicit error bound, and require any approximation of a *sizing or safety parameter* to be validated against the property it claims to guarantee, by measuring the actual false positive rate on a sample rather than by inspecting the formula. A guarantee nobody measures is a comment.
