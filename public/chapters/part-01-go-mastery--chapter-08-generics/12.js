export default `## 8.11 Exercises with Solutions

### Exercise 1: Generic Stack

**Problem**: Implement a thread-safe generic stack with Push, Pop, Peek, Size, and IsEmpty methods.

**Solution**:

\`\`\`go
type Stack[T any] struct {
    mu    sync.RWMutex
    items []T
}

func NewStack[T any]() *Stack[T] {
    return &Stack[T]{items: make([]T, 0)}
}

func (s *Stack[T]) Push(item T) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.items = append(s.items, item)
}

func (s *Stack[T]) Pop() (T, bool) {
    s.mu.Lock()
    defer s.mu.Unlock()
    if len(s.items) == 0 {
        var zero T
        return zero, false
    }
    item := s.items[len(s.items)-1]
    s.items = s.items[:len(s.items)-1]
    return item, true
}

func (s *Stack[T]) Peek() (T, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    if len(s.items) == 0 {
        var zero T
        return zero, false
    }
    return s.items[len(s.items)-1], true
}

func (s *Stack[T]) Size() int {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return len(s.items)
}

func (s *Stack[T]) IsEmpty() bool {
    return s.Size() == 0
}
\`\`\`

### Exercise 2: Map and Filter with Constraints

**Problem**: Implement Map and Filter functions that work correctly with different constraints.

**Solution**:

\`\`\`go
// Filter with proper nil handling
func Filter[T any](s []T, pred func(T) bool) []T {
    if s == nil {
        return nil
    }
    result := make([]T, 0, len(s)/2)
    for _, v := range s {
        if pred(v) {
            result = append(result, v)
        }
    }
    return result
}

// Map with transformation
func Map[T, U any](s []T, fn func(T) U) []U {
    if s == nil {
        return nil
    }
    result := make([]U, len(s))
    for i, v := range s {
        result[i] = fn(v)
    }
    return result
}

// FilterMap combines filter and map
func FilterMap[T, U any](s []T, fn func(T) (U, bool)) []U {
    result := make([]U, 0)
    for _, v := range s {
        if u, ok := fn(v); ok {
            result = append(result, u)
        }
    }
    return result
}

// Usage
numbers := []int{1, 2, 3, 4, 5}
evens := Filter(numbers, func(n int) bool { return n%2 == 0 })
// [2, 4]

doubled := Map(numbers, func(n int) int { return n * 2 })
// [2, 4, 6, 8, 10]

evenStrings := FilterMap(numbers, func(n int) (string, bool) {
    if n%2 == 0 {
        return fmt.Sprintf("even-%d", n), true
    }
    return "", false
})
// ["even-2", "even-4"]
\`\`\`

### Exercise 3: Generic LRU Cache

**Problem**: Build a generic LRU cache with configurable size.

**Solution**:

\`\`\`go
type LRUCache[K comparable, V any] struct {
    mu       sync.Mutex
    capacity int
    items    map[K]*lruEntry[K, V]
    head     *lruEntry[K, V]
    tail     *lruEntry[K, V]
}

type lruEntry[K comparable, V any] struct {
    key   K
    value V
    prev  *lruEntry[K, V]
    next  *lruEntry[K, V]
}

func NewLRUCache[K comparable, V any](capacity int) *LRUCache[K, V] {
    return &LRUCache[K, V]{
        capacity: capacity,
        items:    make(map[K]*lruEntry[K, V]),
    }
}

func (c *LRUCache[K, V]) Get(key K) (V, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    entry, ok := c.items[key]
    if !ok {
        var zero V
        return zero, false
    }

    c.moveToFront(entry)
    return entry.value, true
}

func (c *LRUCache[K, V]) Put(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if entry, ok := c.items[key]; ok {
        entry.value = value
        c.moveToFront(entry)
        return
    }

    entry := &lruEntry[K, V]{key: key, value: value}
    c.items[key] = entry
    c.addToFront(entry)

    if len(c.items) > c.capacity {
        c.removeTail()
    }
}

func (c *LRUCache[K, V]) moveToFront(entry *lruEntry[K, V]) {
    if entry == c.head {
        return
    }
    c.remove(entry)
    c.addToFront(entry)
}

func (c *LRUCache[K, V]) addToFront(entry *lruEntry[K, V]) {
    entry.prev = nil
    entry.next = c.head
    if c.head != nil {
        c.head.prev = entry
    }
    c.head = entry
    if c.tail == nil {
        c.tail = entry
    }
}

func (c *LRUCache[K, V]) remove(entry *lruEntry[K, V]) {
    if entry.prev != nil {
        entry.prev.next = entry.next
    } else {
        c.head = entry.next
    }
    if entry.next != nil {
        entry.next.prev = entry.prev
    } else {
        c.tail = entry.prev
    }
}

func (c *LRUCache[K, V]) removeTail() {
    if c.tail == nil {
        return
    }
    delete(c.items, c.tail.key)
    c.remove(c.tail)
}
\`\`\`

### Exercise 4: Generic Pipeline

**Problem**: Create a generic pipeline system where operations can be chained.

**Solution**:

\`\`\`go
type Pipeline[T any] struct {
    source   []T
    stages   []func([]T) []T
}

func NewPipeline[T any](source []T) *Pipeline[T] {
    return &Pipeline[T]{source: source}
}

func (p *Pipeline[T]) Filter(pred func(T) bool) *Pipeline[T] {
    p.stages = append(p.stages, func(items []T) []T {
        result := make([]T, 0)
        for _, item := range items {
            if pred(item) {
                result = append(result, item)
            }
        }
        return result
    })
    return p
}

func (p *Pipeline[T]) Take(n int) *Pipeline[T] {
    p.stages = append(p.stages, func(items []T) []T {
        if n >= len(items) {
            return items
        }
        return items[:n]
    })
    return p
}

func (p *Pipeline[T]) Skip(n int) *Pipeline[T] {
    p.stages = append(p.stages, func(items []T) []T {
        if n >= len(items) {
            return []T{}
        }
        return items[n:]
    })
    return p
}

func (p *Pipeline[T]) Execute() []T {
    result := p.source
    for _, stage := range p.stages {
        result = stage(result)
    }
    return result
}

// Transform creates a new pipeline with different type
func Transform[T, U any](p *Pipeline[T], fn func(T) U) *Pipeline[U] {
    items := p.Execute()
    result := make([]U, len(items))
    for i, item := range items {
        result[i] = fn(item)
    }
    return NewPipeline(result)
}

// Usage
numbers := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

result := NewPipeline(numbers).
    Filter(func(n int) bool { return n%2 == 0 }).
    Skip(1).
    Take(2).
    Execute()
// [4, 6]

strings := Transform(
    NewPipeline(numbers).Filter(func(n int) bool { return n > 5 }),
    func(n int) string { return fmt.Sprintf("num-%d", n) },
).Execute()
// ["num-6", "num-7", "num-8", "num-9", "num-10"]
\`\`\`

### Exercise 5: JSON Schema Validator

**Problem**: Write a generic function that validates a struct against expected types.

**Solution**:

\`\`\`go
type Validator[T any] struct {
    rules []func(T) error
}

func NewValidator[T any]() *Validator[T] {
    return &Validator[T]{}
}

func (v *Validator[T]) AddRule(rule func(T) error) *Validator[T] {
    v.rules = append(v.rules, rule)
    return v
}

func (v *Validator[T]) Validate(item T) error {
    var errs []error
    for _, rule := range v.rules {
        if err := rule(item); err != nil {
            errs = append(errs, err)
        }
    }
    if len(errs) > 0 {
        return errors.Join(errs...)
    }
    return nil
}

// Validation helpers
func Required[T any](fieldName string, getter func(T) any) func(T) error {
    return func(item T) error {
        v := getter(item)
        if v == nil || v == "" || v == 0 {
            return fmt.Errorf("%s is required", fieldName)
        }
        return nil
    }
}

func MinLength[T any](fieldName string, getter func(T) string, min int) func(T) error {
    return func(item T) error {
        v := getter(item)
        if len(v) < min {
            return fmt.Errorf("%s must be at least %d characters", fieldName, min)
        }
        return nil
    }
}

func Range[T any, N cmp.Ordered](fieldName string, getter func(T) N, min, max N) func(T) error {
    return func(item T) error {
        v := getter(item)
        if v < min || v > max {
            return fmt.Errorf("%s must be between %v and %v", fieldName, min, max)
        }
        return nil
    }
}

// Usage
type User struct {
    Name  string
    Email string
    Age   int
}

userValidator := NewValidator[User]().
    AddRule(Required("name", func(u User) any { return u.Name })).
    AddRule(MinLength("name", func(u User) string { return u.Name }, 2)).
    AddRule(Required("email", func(u User) any { return u.Email })).
    AddRule(Range("age", func(u User) int { return u.Age }, 0, 150))

user := User{Name: "A", Email: "", Age: 200}
if err := userValidator.Validate(user); err != nil {
    fmt.Println(err)
    // name must be at least 2 characters
    // email is required
    // age must be between 0 and 150
}
\`\`\`

### Senior at FAANG Track

7. **Generics audit.** For one of your team's services, list every generic type and function. For each, decide whether it is earning its keep. Write the audit with keep/drop/simplify recommendations.

8. **Pre-generics migration.** Take a pre-1.18 helper that uses \`interface{}\` or code generation. Migrate to generics. Benchmark before and after. Document what you found.

9. **Team discipline doc.** Write your team's "when to use generics" guide. Cover the decision framework, the common mistakes, the performance considerations. Publish as the team reference.

10. **Constraint library audit.** List every custom constraint in your codebase. For each, check whether a standard-library equivalent (\`any\`, \`comparable\`, \`cmp.Ordered\`) would suffice. Replace where possible.

---
`;
