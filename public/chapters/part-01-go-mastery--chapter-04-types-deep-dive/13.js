export default `## Exercises

These exercises test your ability to apply the type system concepts from this chapter. Each one targets a specific skill, string processing, generics, map operations, struct design, and memory layout, and includes a complete solution you can compare against after attempting it yourself.

### Exercise 1: String Manipulation

Write a function that counts the number of words in a UTF-8 string, correctly handling multi-byte characters.

**Solution:**

\`\`\`go
func CountWords(s string) int {
    return len(strings.Fields(s))
}

// Or manually handling runes
func CountWordsManual(s string) int {
    count := 0
    inWord := false

    for _, r := range s {
        if unicode.IsSpace(r) {
            if inWord {
                count++
                inWord = false
            }
        } else {
            inWord = true
        }
    }

    if inWord {
        count++
    }

    return count
}

// Test with multi-byte characters
fmt.Println(CountWords("Hello 世界 こんにちは"))  // 3
\`\`\`

### Exercise 2: Generic Filter Function

Implement a generic \`Filter\` function that takes a slice and a predicate function, returning a new slice containing only elements for which the predicate returns true.

**Solution:**

\`\`\`go
func Filter[T any](slice []T, predicate func(T) bool) []T {
    result := make([]T, 0, len(slice)/2)  // Estimate half will match
    for _, v := range slice {
        if predicate(v) {
            result = append(result, v)
        }
    }
    return result
}

// Usage
numbers := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
evens := Filter(numbers, func(n int) bool { return n%2 == 0 })
// evens = [2, 4, 6, 8, 10]

words := []string{"apple", "banana", "apricot", "cherry"}
aWords := Filter(words, func(s string) bool { return strings.HasPrefix(s, "a") })
// aWords = ["apple", "apricot"]
\`\`\`

### Exercise 3: Word Frequency Counter

Build a word frequency counter that normalizes input text (lowercase, strip punctuation) and returns a map of word counts. Then write a \`TopN\` function that returns the N most frequent words sorted by count.

**Solution:**

\`\`\`go
func WordFrequency(text string) map[string]int {
    freq := make(map[string]int)

    // Normalize: lowercase and remove punctuation
    text = strings.ToLower(text)

    // Split into words
    words := strings.FieldsFunc(text, func(r rune) bool {
        return !unicode.IsLetter(r) && !unicode.IsNumber(r)
    })

    for _, word := range words {
        if word != "" {
            freq[word]++
        }
    }

    return freq
}

// Get top N words
func TopN(freq map[string]int, n int) []struct{ Word string; Count int } {
    type wordCount struct {
        Word  string
        Count int
    }

    wc := make([]wordCount, 0, len(freq))
    for word, count := range freq {
        wc = append(wc, wordCount{word, count})
    }

    slices.SortFunc(wc, func(a, b wordCount) int {
        return b.Count - a.Count  // Descending
    })

    if n > len(wc) {
        n = len(wc)
    }

    result := make([]struct{ Word string; Count int }, n)
    for i := 0; i < n; i++ {
        result[i] = struct{ Word string; Count int }{wc[i].Word, wc[i].Count}
    }
    return result
}
\`\`\`

### Exercise 4: Bank Account Struct

Design a thread-safe bank account struct with proper encapsulation: unexported fields, mutex protection, transaction history, and error handling for overdrafts and closed accounts. Store monetary values as \`int64\` cents to avoid floating-point issues.

**Solution:**

\`\`\`go
package bank

import (
    "errors"
    "sync"
    "time"
)

var (
    ErrInsufficientFunds = errors.New("insufficient funds")
    ErrNegativeAmount    = errors.New("amount must be positive")
    ErrAccountClosed     = errors.New("account is closed")
)

type AccountID string

type Transaction struct {
    ID        string
    Type      string  // "deposit", "withdrawal", "transfer"
    Amount    int64   // In cents
    Timestamp time.Time
    Balance   int64   // Balance after transaction
}

type Account struct {
    mu           sync.RWMutex
    id           AccountID
    balance      int64  // In cents to avoid float issues
    transactions []Transaction
    closed       bool
}

func NewAccount(id AccountID, initialDeposit int64) (*Account, error) {
    if initialDeposit < 0 {
        return nil, ErrNegativeAmount
    }

    acc := &Account{
        id:      id,
        balance: initialDeposit,
    }

    if initialDeposit > 0 {
        acc.transactions = append(acc.transactions, Transaction{
            ID:        generateID(),
            Type:      "deposit",
            Amount:    initialDeposit,
            Timestamp: time.Now(),
            Balance:   initialDeposit,
        })
    }

    return acc, nil
}

func (a *Account) Deposit(amount int64) error {
    if amount <= 0 {
        return ErrNegativeAmount
    }

    a.mu.Lock()
    defer a.mu.Unlock()

    if a.closed {
        return ErrAccountClosed
    }

    a.balance += amount
    a.transactions = append(a.transactions, Transaction{
        ID:        generateID(),
        Type:      "deposit",
        Amount:    amount,
        Timestamp: time.Now(),
        Balance:   a.balance,
    })

    return nil
}

func (a *Account) Withdraw(amount int64) error {
    if amount <= 0 {
        return ErrNegativeAmount
    }

    a.mu.Lock()
    defer a.mu.Unlock()

    if a.closed {
        return ErrAccountClosed
    }

    if a.balance < amount {
        return ErrInsufficientFunds
    }

    a.balance -= amount
    a.transactions = append(a.transactions, Transaction{
        ID:        generateID(),
        Type:      "withdrawal",
        Amount:    amount,
        Timestamp: time.Now(),
        Balance:   a.balance,
    })

    return nil
}

func (a *Account) Balance() int64 {
    a.mu.RLock()
    defer a.mu.RUnlock()
    return a.balance
}

func (a *Account) ID() AccountID {
    return a.id
}

func (a *Account) History() []Transaction {
    a.mu.RLock()
    defer a.mu.RUnlock()

    // Return a copy to prevent modification
    result := make([]Transaction, len(a.transactions))
    copy(result, a.transactions)
    return result
}

func (a *Account) Close() error {
    a.mu.Lock()
    defer a.mu.Unlock()

    if a.closed {
        return ErrAccountClosed
    }

    a.closed = true
    return nil
}

func generateID() string {
    return fmt.Sprintf("txn_%d", time.Now().UnixNano())
}
\`\`\`

### Exercise 5: Memory Layout Optimization

Given the struct below, calculate its size on a 64-bit system by working out alignment and padding for each field. Then reorder the fields to minimize wasted padding bytes.

\`\`\`go
type Record struct {
    Flag      bool
    Timestamp int64
    Status    byte
    Value     float64
    ID        int32
}
\`\`\`

**Solution:**

\`\`\`go
// Original layout (on 64-bit system):
// Flag      bool    1 byte  + 7 bytes padding
// Timestamp int64   8 bytes
// Status    byte    1 byte  + 7 bytes padding
// Value     float64 8 bytes
// ID        int32   4 bytes + 4 bytes padding
// Total: 40 bytes

// Optimized layout:
type RecordOptimized struct {
    Timestamp int64   // 8 bytes (largest first)
    Value     float64 // 8 bytes
    ID        int32   // 4 bytes
    Flag      bool    // 1 byte
    Status    byte    // 1 byte + 2 bytes padding
}
// Total: 24 bytes (40% reduction!)

// Verify with unsafe
import "unsafe"
fmt.Println("Original:", unsafe.Sizeof(Record{}))           // 40
fmt.Println("Optimized:", unsafe.Sizeof(RecordOptimized{})) // 24
\`\`\`

### Junior to FAANG-Entry Track

These exercises test the operational mental model an entry-level Go interview probes. Time yourself. Each should complete in under 30 minutes from a blank file.

6. **Write a function \`DeduplicateOrdered[T comparable](s []T) []T\`** that returns a new slice with duplicates removed, preserving first-occurrence order. Self-check: \`["a", "b", "a", "c", "b"]\` returns \`["a", "b", "c"]\`. Write a benchmark on a slice of 100,000 strings with 80% duplicates.

7. **Write a \`LRUCache[K comparable, V any]\` with \`Get(K) (V, bool)\` and \`Put(K, V)\`**, capacity-bounded, single-goroutine (no locking). Use \`container/list\` plus a \`map[K]*list.Element\`. Self-check: capacity 3, after \`Put(1,"a"); Put(2,"b"); Put(3,"c"); Get(1); Put(4,"d")\`, key 2 is evicted (not 1).

8. **Write \`Histogram(values []float64, buckets int) []int\`** that returns a count of values falling into each of \`buckets\` equal-width buckets. Handle edge cases: zero-length input, single-value input, all values equal.

9. **Reproduce the slice-aliasing bug.** Write a function that takes a \`[]int\`, appends one element, and returns the new slice. Construct a call site where the returned slice aliases the caller's input. Then fix the function to guarantee independence using \`slices.Clone\`.

10. **Design a domain for a todo-list service.** Define types \`UserID\`, \`TodoID\`, \`Priority\` (enum), \`Todo\` (struct), and \`TodoList\` (slice of Todo). Write a \`Validate()\` method on \`Todo\` that enforces non-empty title and a reasonable \`DueAt\`. Self-check: a \`Todo{Title: ""}\` fails validation.

### Senior at FAANG Track

These exercises test the architecture judgment that distinguishes a senior Go engineer.

11. **Type-safety audit on your team's service.** Find every \`int64\` or \`string\` that represents a domain identifier in a service you maintain. Count them. For each, decide whether it should be promoted to a named type. Write the migration as a single PR. The deliverable is the PR plus a 300-word note on which conversions you had to add at boundaries and which bugs (if any) the compiler caught during the migration.

12. **\`fieldalignment\` audit.** Run \`fieldalignment\` against a production Go service. Count the number of flagged structs, sort by allocation frequency (get the numbers from pprof), and fix the top five. Benchmark before and after. The deliverable is the before-and-after RSS and allocation-rate numbers.

13. **Design a \`Money\` type.** Implement \`Money\` as a struct with \`Amount int64\` (in smallest currency unit) and \`Currency Currency\`. Implement \`Add\`, \`Subtract\`, \`Multiply(n int64)\`, and \`Divide(n int64) (Money, Money)\` (result plus remainder). The currency mismatch on \`Add\` must be an error. Write a comprehensive test suite. The interesting design decisions are around rounding, overflow, and equality across currencies.

14. **Benchmark \`sync.Map\` vs \`map + RWMutex\`.** Design a microbenchmark harness that varies the read/write ratio from 99:1 to 1:99 and the key set size from 100 to 1,000,000. Plot the crossover points. The deliverable is a reproducible benchmark plus a one-page decision guide for "which to use when" that you can share with the team.

15. **Audit a map usage for eviction.** Find a long-lived map in a service you maintain (a cache, a session store, a counter table). Determine whether it grows without bound. If so, add explicit eviction or periodic rebuild via \`maps.Clone\`. Measure the RSS trajectory over a week before and after. The deliverable is the RSS graph plus the code change.

---
`;
