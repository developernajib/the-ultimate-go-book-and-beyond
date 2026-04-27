export default `## 10B.3 math/rand/v2, Modern Random Number Generation (Go 1.22)

### Why math/rand Was Problematic

The original \`math/rand\` package had three well-known issues that caused subtle bugs:

1. **Global mutex** - The default source used a global \`lockedSource\` with a \`sync.Mutex\`, creating contention in concurrent code
2. **Predictable default seed** - Before Go 1.20, the default source used seed \`0\`, producing deterministic output that surprised developers who forgot to call \`rand.Seed()\`
3. **Not auto-seeded** - Every program had to manually call \`rand.Seed(time.Now().UnixNano())\` or get the same sequence every run

Go 1.20 deprecated \`rand.Seed()\` and added automatic seeding, but the API remained awkward. Go 1.22 introduced \`math/rand/v2\` as a clean break.

### The New API

The v2 package eliminates the manual seeding ceremony entirely. Global functions like \`rand.IntN\` are automatically seeded with a high-quality source, and the function names use consistent capitalization (\`IntN\` instead of \`Intn\`). A new generic function \`rand.N[T]\` accepts any integer type, removing the need for separate \`Int31n\`, \`Int63n\` variants.

\`\`\`go
// OLD (deprecated)
import "math/rand"
rand.Seed(time.Now().UnixNano()) // required before Go 1.20
n := rand.Intn(100)

// NEW (Go 1.22+)
import "math/rand/v2"
n := rand.IntN(100)           // auto-seeded, cleaner name
n2 := rand.N(int64(1000))    // generic - works with any integer type
\`\`\`

Key API changes in \`math/rand/v2\`:

| Old (\`math/rand\`) | New (\`math/rand/v2\`) | Notes |
|--------------------------|-----------------------------|------------------------------------|
| \`rand.Intn(n)\` | \`rand.IntN(n)\` | Capitalized N for consistency |
| \`rand.Int31n(n)\` | \`rand.Int32N(n)\` | Uses actual bit width in name |
| \`rand.Int63n(n)\` | \`rand.Int64N(n)\` | Same pattern |
| \`rand.Seed(s)\` | *removed* | Auto-seeded, no global seed |
| \`rand.Read(b)\` | *removed* | Use \`crypto/rand.Read\` instead |
| - | \`rand.N[T](n T)\` | Generic, works with any integer |

### New PRNG Algorithms

One of the most significant improvements in \`math/rand/v2\` is the replacement of the original linear congruential generator with two modern, well-studied algorithms. Rather than relying on a single built-in source, the package now lets you explicitly choose between PCG and ChaCha8 depending on your requirements for speed versus unpredictability. Both are instantiated with explicit seeds, which removes the ambiguity of the old global seed and makes the randomness source visible and auditable in your code.

\`math/rand/v2\` ships with two PRNG implementations:

\`\`\`go
// PCG - Permuted Congruential Generator (the default)
// Fast, small state (16 bytes), good statistical quality
// This is what you get when you use rand.IntN() directly
rng := rand.New(rand.NewPCG(42, 99)) // two uint64 seeds
n := rng.IntN(100)

// ChaCha8 - Based on the ChaCha20 stream cipher
// Cryptographically strong PRNG (not a CSPRNG replacement)
// Slower than PCG but unpredictable output
rng2 := rand.New(rand.NewChaCha8([32]byte{1, 2, 3}))
n2 := rng2.IntN(100)
\`\`\`

**PCG** is the default for the global functions (\`rand.IntN\`, \`rand.Float64\`, etc.). It is fast and produces excellent statistical output. **ChaCha8** provides stronger guarantees, its output is computationally indistinguishable from random, making it suitable for cases where you need unpredictability but not full cryptographic security.

### crypto/rand vs math/rand/v2

| Use case | Package |
|-----------------------------------|----------------------|
| Session tokens, API keys | \`crypto/rand\` |
| Password salts, encryption nonces | \`crypto/rand\` |
| Shuffling a playlist | \`math/rand/v2\` |
| Monte Carlo simulation | \`math/rand/v2\` |
| Sampling data for testing | \`math/rand/v2\` |
| Load balancer jitter | \`math/rand/v2\` |

**Rule of thumb:** If the value protects something (authentication, encryption, authorization), use \`crypto/rand\`. For everything else, \`math/rand/v2\` is correct.

### Reproducible Tests with Custom Source

Non-deterministic tests that rely on randomness can pass on one run and fail on another, making bugs intermittent and difficult to reproduce. Constructing a \`rand.New\` with a fixed seed gives you a deterministic sequence that is stable across runs, so a test that shuffles or samples data will always produce the same output and can assert against exact expected values. When a test does fail, you can document the seed used and replay the exact same sequence to reproduce the failure, which is far easier than hunting a flaky test with no reproducible trigger.

\`\`\`go
func TestShuffle(t *testing.T) {
    // Fixed seed produces deterministic sequence - ideal for tests
    rng := rand.New(rand.NewChaCha8([32]byte{42}))

    data := []int{1, 2, 3, 4, 5}
    rng.Shuffle(len(data), func(i, j int) {
        data[i], data[j] = data[j], data[i]
    })

    // Same seed always produces same shuffle
    expected := []int{3, 1, 5, 2, 4}
    if !slices.Equal(data, expected) {
        t.Errorf("unexpected shuffle: %v", data)
    }
}
\`\`\`

---
`;
