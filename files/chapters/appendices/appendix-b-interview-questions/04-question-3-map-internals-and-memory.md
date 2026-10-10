## Question 3: Map Internals and Memory

**Level**: Mid

**Question**: What's wrong with this code? How does Go implement maps internally?

```go
type User struct {
    Name  string
    Email string
}

func main() {
    users := make(map[string]User)
    users["john"] = User{Name: "John", Email: "john@example.com"}

    users["john"].Email = "newemail@example.com"  // Won't compile!
}
```

**Answer**:

The code fails with: `cannot assign to struct field users["john"].Email in map`

**Explanation**:

Map values are **not addressable** in Go. When you access a map value, Go returns a copy, not a reference. This is a deliberate design decision related to how maps work internally.

**Go Map Internals**:

```go
// Simplified map structure
type hmap struct {
    count     int        // Number of elements
    B         uint8      // log2 of bucket count
    buckets   unsafe.Pointer
    oldbuckets unsafe.Pointer  // During growth
    // ... more fields
}

// Each bucket holds up to 8 key-value pairs
type bmap struct {
    tophash [8]uint8     // Hash of each key's top byte
    keys    [8]keytype   // 8 keys
    values  [8]valuetype // 8 values
    overflow *bmap       // Overflow bucket
}
```

When you access `users["john"]`:
1. Go hashes the key "john"
2. Uses the hash to find the bucket
3. Scans the bucket's tophash array
4. **Copies** the value to return it

**Why Maps Grow**:

As you add elements, Go may need to grow the map:
1. Allocates a new, larger bucket array (2x size)
2. Rehashes all keys
3. Migrates elements to new buckets
4. This means addresses would change during growth!

If Go allowed addressing map values, those addresses would become invalid during map growth.

**The Fix - Use Pointer Values**:

```go
func main() {
    users := make(map[string]*User)
    users["john"] = &User{Name: "John", Email: "john@example.com"}

    users["john"].Email = "newemail@example.com"  // Works!
}
```

**Alternative - Reassign the Entire Value**:

```go
func main() {
    users := make(map[string]User)
    users["john"] = User{Name: "John", Email: "john@example.com"}

    user := users["john"]
    user.Email = "newemail@example.com"
    users["john"] = user  // Reassign
}
```

**Production Consideration - Map Performance**:

```go
// Pre-size maps when you know approximate size
users := make(map[string]*User, 10000)  // Avoids multiple growths

// Each map growth:
// 1. Allocates new memory (2x size)
// 2. Rehashes all keys
// 3. Copies all values
// 4. Triggers GC for old buckets
```

**Memory Layout**:

```
Map with 3 elements (capacity 8):
┌─────────────┐
│    hmap     │
│  count: 3   │
│  B: 0 (2^0) │
└─────┬───────┘
      │
      ↓
┌──────────────────────────────────┐
│         Bucket (bmap)            │
├──────────┬──────────┬────────────┤
│ tophash  │   keys   │  values    │
│ [8]uint8 │ [8]string│ [8]User    │
├──────────┼──────────┼────────────┤
│  0xA4    │  "john"  │  User{..}  │
│  0xB2    │  "jane"  │  User{..}  │
│  0xC7    │  "bob"   │  User{..}  │
│  0x00    │    ""    │   zero     │
│   ...    │   ...    │    ...     │
└──────────┴──────────┴────────────┘
```

**Common Follow-up**: What's the time complexity of map operations?

- **Average case**: O(1)
- **Worst case**: O(n) during growth or with many hash collisions
- **Load factor**: Go grows the map when it's ~6.5 elements per bucket

**Companies that asked this**: Google, Cloudflare, Uber

---
