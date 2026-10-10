## 77.9 Company Case Studies

### Google: Search Index Lookup with Binary Search

Inverted-index posting lists are sorted by document ID, which makes binary search (and its galloping variants) the workhorse of document retrieval:

```go
package searchindex

import (
    "sort"
    "strings"
    "sync"
)

// Document represents an indexed document
type Document struct {
    ID        uint64
    URL       string
    Title     string
    Content   string
    PageRank  float64
    Timestamp int64
}

// PostingList stores sorted document IDs for a term
type PostingList struct {
    DocIDs []uint64 // Sorted list of document IDs
}

// SearchIndex implements an inverted index with binary search
type SearchIndex struct {
    index    map[string]*PostingList // term -> posting list
    docs     map[uint64]*Document     // docID -> document
    mu       sync.RWMutex
}

// NewSearchIndex creates a new search index
func NewSearchIndex() *SearchIndex {
    return &SearchIndex{
        index: make(map[string]*PostingList),
        docs:  make(map[uint64]*Document),
    }
}

// IndexDocument adds a document to the index
func (si *SearchIndex) IndexDocument(doc *Document) {
    si.mu.Lock()
    defer si.mu.Unlock()

    si.docs[doc.ID] = doc

    // Tokenize and index terms
    terms := tokenize(doc.Title + " " + doc.Content)
    for _, term := range terms {
        if si.index[term] == nil {
            si.index[term] = &PostingList{}
        }
        // Insert maintaining sorted order using binary search
        pos := sort.Search(len(si.index[term].DocIDs), func(i int) bool {
            return si.index[term].DocIDs[i] >= doc.ID
        })
        if pos < len(si.index[term].DocIDs) && si.index[term].DocIDs[pos] == doc.ID {
            continue // Already indexed
        }
        // Insert at position
        si.index[term].DocIDs = append(si.index[term].DocIDs, 0)
        copy(si.index[term].DocIDs[pos+1:], si.index[term].DocIDs[pos:])
        si.index[term].DocIDs[pos] = doc.ID
    }
}

// Search finds documents matching all query terms
func (si *SearchIndex) Search(query string, limit int) []*Document {
    si.mu.RLock()
    defer si.mu.RUnlock()

    terms := tokenize(query)
    if len(terms) == 0 {
        return nil
    }

    // Get posting lists for all terms
    var lists []*PostingList
    for _, term := range terms {
        if pl, ok := si.index[term]; ok {
            lists = append(lists, pl)
        } else {
            return nil // Term not found, no results
        }
    }

    // Intersect posting lists using binary search
    result := si.intersectPostingLists(lists)

    // Convert to documents and rank
    docs := make([]*Document, 0, len(result))
    for _, docID := range result {
        if doc, ok := si.docs[docID]; ok {
            docs = append(docs, doc)
        }
    }

    // Sort by PageRank
    sort.Slice(docs, func(i, j int) bool {
        return docs[i].PageRank > docs[j].PageRank
    })

    if len(docs) > limit {
        docs = docs[:limit]
    }
    return docs
}

// intersectPostingLists finds common document IDs across all lists
func (si *SearchIndex) intersectPostingLists(lists []*PostingList) []uint64 {
    if len(lists) == 0 {
        return nil
    }

    // Start with smallest list for efficiency
    sort.Slice(lists, func(i, j int) bool {
        return len(lists[i].DocIDs) < len(lists[j].DocIDs)
    })

    result := make([]uint64, len(lists[0].DocIDs))
    copy(result, lists[0].DocIDs)

    for i := 1; i < len(lists); i++ {
        result = si.intersectTwo(result, lists[i].DocIDs)
        if len(result) == 0 {
            break
        }
    }

    return result
}

// intersectTwo intersects two sorted lists using binary search
func (si *SearchIndex) intersectTwo(a, b []uint64) []uint64 {
    result := make([]uint64, 0, min(len(a), len(b)))

    // Use smaller list for iteration, binary search in larger
    if len(a) > len(b) {
        a, b = b, a
    }

    for _, id := range a {
        // Binary search for id in b
        pos := sort.Search(len(b), func(i int) bool {
            return b[i] >= id
        })
        if pos < len(b) && b[pos] == id {
            result = append(result, id)
        }
    }

    return result
}

// RangeSearch finds documents within a PageRank range
func (si *SearchIndex) RangeSearch(minRank, maxRank float64) []*Document {
    si.mu.RLock()
    defer si.mu.RUnlock()

    // Create sorted view by PageRank
    sortedDocs := make([]*Document, 0, len(si.docs))
    for _, doc := range si.docs {
        sortedDocs = append(sortedDocs, doc)
    }
    sort.Slice(sortedDocs, func(i, j int) bool {
        return sortedDocs[i].PageRank < sortedDocs[j].PageRank
    })

    // Binary search for range bounds
    start := sort.Search(len(sortedDocs), func(i int) bool {
        return sortedDocs[i].PageRank >= minRank
    })
    end := sort.Search(len(sortedDocs), func(i int) bool {
        return sortedDocs[i].PageRank > maxRank
    })

    // start > end whenever minRank > maxRank, which is an empty range,
    // not an error. Without this guard the slice expression panics.
    if start >= len(sortedDocs) || start >= end {
        return nil
    }

    return sortedDocs[start:end]
}

func tokenize(text string) []string {
    text = strings.ToLower(text)
    words := strings.Fields(text)
    seen := make(map[string]bool)
    result := make([]string, 0, len(words))
    for _, word := range words {
        word = strings.Trim(word, ".,!?;:\"'")
        if len(word) > 0 && !seen[word] {
            seen[word] = true
            result = append(result, word)
        }
    }
    return result
}

```

### Amazon: Product Inventory Threshold Search

Threshold questions over sorted inventory data ("first warehouse with stock above N") are binary searches over the answer space:

```go
package inventory

import (
    "sort"
    "sync"
    "time"
)

// Product represents an inventory item
type Product struct {
    SKU           string
    Name          string
    Quantity      int
    PriceCents    int64
    ReorderPoint  int
    LastRestocked time.Time
}

// InventoryManager handles product inventory with efficient queries
type InventoryManager struct {
    products       map[string]*Product // SKU -> Product
    byQuantity     []*Product          // Sorted by quantity
    byPrice        []*Product          // Sorted by price
    needsRebuilding bool
    mu             sync.RWMutex
}

// NewInventoryManager creates a new inventory manager
func NewInventoryManager() *InventoryManager {
    return &InventoryManager{
        products: make(map[string]*Product),
    }
}

// AddProduct adds or updates a product
func (im *InventoryManager) AddProduct(p *Product) {
    im.mu.Lock()
    defer im.mu.Unlock()
    im.products[p.SKU] = p
    im.needsRebuilding = true
}

// rebuildIndexes rebuilds sorted indexes
func (im *InventoryManager) rebuildIndexes() {
    if !im.needsRebuilding {
        return
    }

    im.byQuantity = make([]*Product, 0, len(im.products))
    im.byPrice = make([]*Product, 0, len(im.products))

    for _, p := range im.products {
        im.byQuantity = append(im.byQuantity, p)
        im.byPrice = append(im.byPrice, p)
    }

    sort.Slice(im.byQuantity, func(i, j int) bool {
        return im.byQuantity[i].Quantity < im.byQuantity[j].Quantity
    })

    sort.Slice(im.byPrice, func(i, j int) bool {
        return im.byPrice[i].PriceCents < im.byPrice[j].PriceCents
    })

    im.needsRebuilding = false
}

// FindLowStock finds products below threshold quantity
func (im *InventoryManager) FindLowStock(threshold int) []*Product {
    im.mu.Lock()
    im.rebuildIndexes()
    im.mu.Unlock()

    im.mu.RLock()
    defer im.mu.RUnlock()

    // Binary search for upper bound
    pos := sort.Search(len(im.byQuantity), func(i int) bool {
        return im.byQuantity[i].Quantity >= threshold
    })

    result := make([]*Product, pos)
    copy(result, im.byQuantity[:pos])
    return result
}

// FindProductsNeedingReorder finds products at or below reorder point
func (im *InventoryManager) FindProductsNeedingReorder() []*Product {
    im.mu.RLock()
    defer im.mu.RUnlock()

    var result []*Product
    for _, p := range im.products {
        if p.Quantity <= p.ReorderPoint {
            result = append(result, p)
        }
    }
    return result
}

// FindPriceRange finds products within price range (in cents)
func (im *InventoryManager) FindPriceRange(minPriceCents, maxPriceCents int64) []*Product {
    im.mu.Lock()
    im.rebuildIndexes()
    im.mu.Unlock()

    im.mu.RLock()
    defer im.mu.RUnlock()

    // Binary search for lower bound
    start := sort.Search(len(im.byPrice), func(i int) bool {
        return im.byPrice[i].PriceCents >= minPriceCents
    })

    // Binary search for upper bound
    end := sort.Search(len(im.byPrice), func(i int) bool {
        return im.byPrice[i].PriceCents > maxPriceCents
    })

    // A caller passing minPriceCents > maxPriceCents yields start > end. That is an
    // empty range. Guard it, or make() panics on a negative length.
    if start >= len(im.byPrice) || start >= end {
        return nil
    }

    result := make([]*Product, end-start)
    copy(result, im.byPrice[start:end])
    return result
}

// FindOptimalRestockQuantity uses binary search on answer
func (im *InventoryManager) FindOptimalRestockQuantity(
    sku string,
    holdingCostCentsPerUnit int64,
    orderCostCentsPerOrder int64,
    demandPerDay int,
) int {
    im.mu.RLock()
    product, ok := im.products[sku]
    im.mu.RUnlock()

    if !ok {
        return 0
    }

    // Economic Order Quantity approximation using binary search
    // Minimize total cost = ordering cost + holding cost (in cents)

    calcTotalCost := func(orderQty int) int64 {
        if orderQty <= 0 {
            return math.MaxInt64
        }
        annualDemand := int64(demandPerDay * 365)
        orderingCost := (annualDemand * orderCostCentsPerOrder) / int64(orderQty)
        holdingCost := (int64(orderQty) * holdingCostCentsPerUnit) / 2
        return orderingCost + holdingCost
    }

    // Ternary search for optimal quantity
    left, right := 1, demandPerDay*365
    for right-left > 2 {
        mid1 := left + (right-left)/3
        mid2 := right - (right-left)/3

        if calcTotalCost(mid1) < calcTotalCost(mid2) {
            right = mid2
        } else {
            left = mid1
        }
    }

    // Check remaining candidates
    bestQty := left
    bestCost := calcTotalCost(left)
    for q := left + 1; q <= right; q++ {
        if cost := calcTotalCost(q); cost < bestCost {
            bestCost = cost
            bestQty = q
        }
    }

    _ = product // Would use product info for more sophisticated calculation
    return bestQty
}
```

### Uber: Driver Search by ETA

Finding all drivers within an ETA cutoff in a sorted-by-ETA candidate list is a binary search for the boundary:

```go
package drivermatch

import (
    "math"
    "sort"
    "sync"
)

// Location represents GPS coordinates
type Location struct {
    Lat, Lng float64
}

// Driver represents an available driver
type Driver struct {
    ID       string
    Location Location
    Rating   float64
    ETA      float64 // Minutes to pickup
    Busy     bool
}

// DriverSearchService finds drivers using binary search
type DriverSearchService struct {
    drivers   map[string]*Driver
    byETA     []*Driver // Sorted by ETA
    mu        sync.RWMutex
}

// NewDriverSearchService creates a new driver search service
func NewDriverSearchService() *DriverSearchService {
    return &DriverSearchService{
        drivers: make(map[string]*Driver),
    }
}

// UpdateDriver updates driver location and recalculates ETA
func (ds *DriverSearchService) UpdateDriver(d *Driver, pickupLoc Location) {
    ds.mu.Lock()
    defer ds.mu.Unlock()

    // Calculate ETA based on distance (simplified)
    d.ETA = calculateETA(d.Location, pickupLoc)
    ds.drivers[d.ID] = d
}

// RebuildETAIndex rebuilds the sorted ETA index
func (ds *DriverSearchService) RebuildETAIndex(pickupLoc Location) {
    ds.mu.Lock()
    defer ds.mu.Unlock()

    ds.byETA = make([]*Driver, 0, len(ds.drivers))
    for _, d := range ds.drivers {
        if !d.Busy {
            d.ETA = calculateETA(d.Location, pickupLoc)
            ds.byETA = append(ds.byETA, d)
        }
    }

    sort.Slice(ds.byETA, func(i, j int) bool {
        return ds.byETA[i].ETA < ds.byETA[j].ETA
    })
}

// FindDriversWithinETA finds all available drivers within max ETA
func (ds *DriverSearchService) FindDriversWithinETA(maxETA float64) []*Driver {
    ds.mu.RLock()
    defer ds.mu.RUnlock()

    // Binary search for upper bound
    pos := sort.Search(len(ds.byETA), func(i int) bool {
        return ds.byETA[i].ETA > maxETA
    })

    result := make([]*Driver, pos)
    copy(result, ds.byETA[:pos])
    return result
}

// FindBestDriver finds optimal driver balancing ETA and rating
func (ds *DriverSearchService) FindBestDriver(maxETA float64, minRating float64) *Driver {
    ds.mu.RLock()
    defer ds.mu.RUnlock()

    // Get all drivers within ETA using binary search
    pos := sort.Search(len(ds.byETA), func(i int) bool {
        return ds.byETA[i].ETA > maxETA
    })

    var best *Driver
    bestScore := -1.0

    // Score = rating / (1 + ETA/10), prioritizing nearby high-rated drivers
    for i := 0; i < pos; i++ {
        d := ds.byETA[i]
        if d.Rating >= minRating {
            score := d.Rating / (1 + d.ETA/10)
            if score > bestScore {
                bestScore = score
                best = d
            }
        }
    }

    return best
}

// FindMinETAForRating finds minimum achievable ETA with given rating threshold.
// This is a linear scan by design, not a binary search. byETA is ordered by
// ETA, not by rating, so the predicate "rating >= minRating" is not monotone
// along it and binary search does not apply. The first match in ETA order is
// the answer, so the scan stops early, but the worst case is O(n).
func (ds *DriverSearchService) FindMinETAForRating(minRating float64) float64 {
    ds.mu.RLock()
    defer ds.mu.RUnlock()

    for _, d := range ds.byETA {
        if d.Rating >= minRating {
            return d.ETA
        }
    }

    return -1 // No driver found
}

// FindETAThreshold uses binary search on answer to find ETA that gives N drivers
func (ds *DriverSearchService) FindETAThreshold(targetDrivers int) float64 {
    ds.mu.RLock()
    defer ds.mu.RUnlock()

    if len(ds.byETA) == 0 {
        return -1
    }

    if len(ds.byETA) <= targetDrivers {
        return ds.byETA[len(ds.byETA)-1].ETA
    }

    // Binary search on ETA values
    left := ds.byETA[0].ETA
    right := ds.byETA[len(ds.byETA)-1].ETA

    for right-left > 0.1 { // Precision of 0.1 minutes
        mid := left + (right-left)/2

        // Count drivers within this ETA
        count := sort.Search(len(ds.byETA), func(i int) bool {
            return ds.byETA[i].ETA > mid
        })

        if count >= targetDrivers {
            right = mid
        } else {
            left = mid
        }
    }

    return right
}

func calculateETA(from, to Location) float64 {
    // Haversine distance calculation (simplified)
    const R = 6371 // Earth's radius in km

    dLat := (to.Lat - from.Lat) * math.Pi / 180
    dLng := (to.Lng - from.Lng) * math.Pi / 180

    a := math.Sin(dLat/2)*math.Sin(dLat/2) +
        math.Cos(from.Lat*math.Pi/180)*math.Cos(to.Lat*math.Pi/180)*
            math.Sin(dLng/2)*math.Sin(dLng/2)

    c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
    distance := R * c

    // Assume average speed of 30 km/h in city
    return distance / 30 * 60 // Return in minutes
}
```

### Junior -> FAANG: Reading Production Systems as Algorithm Examples

Each case study above embeds a binary search in a realistic data management context. The Google inverted index uses `sort.Search` for both insertion (finding the correct position) and intersection (binary search in the larger list). The Amazon inventory manager uses `sort.Search` for price range queries with explicit lower and upper bounds. The Uber driver search applies binary search on ETA values to find all drivers within a threshold.

Notice that all three use `sort.Search` rather than a raw loop. This is the correct habit: `sort.Search` is tested, documented, and communicates intent clearly. The raw loop versions would be equivalent in performance but harder to reason about.

For the Amazon ternary search in `FindOptimalRestockQuantity`: ternary search finds the minimum of a unimodal function (not monotone, but convex) in O(log n) iterations by eliminating one third of the search space each time. Know that this is distinct from binary search on answer (which requires a monotone feasibility function) and that ternary search requires unimodality (a single minimum with no local minima). The economic order quantity function is convex, so ternary search is applicable.

### Senior @ FAANG: System Design Implications of Binary Search Choices

The Google search index case study reveals a critical design tradeoff. The `intersectPostingLists` function sorts lists by size and uses the smallest list for iteration, binary-searching in each larger list. This is the "merge intersection" pattern with O(|smallest| * log(|largest|)) complexity. For very skewed lists (one list has 100 elements, another has 100 million), this is dramatically better than the O(|smallest| + |largest|) merge approach.

The tradeoff is that binary search in a large list requires random access, which destroys cache locality for disk-resident lists. The standard production solution is a two-phase approach: use skiplist-style compressed posting lists for lists that are short enough to fit in memory, and use merge intersection for lists that must be streamed from disk. A senior engineer designing the index intersection algorithm owns this decision and documents the crossover threshold at which to switch strategies.

The Uber `FindETAThreshold` function applies binary search on floating-point values with a `0.1` minute precision stop condition. This is correct but requires knowing that floating-point binary search needs an explicit precision threshold rather than an exact equality check, because floating-point midpoints may not converge to a single value. Always use a threshold or iteration count limit for floating-point binary search, never a strict equality exit condition.
