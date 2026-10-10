// internal/upstream/random.go
package upstream

import (
    "math/rand/v2"
    "sync"
    "time"
)

// lockedRand provides thread-safe random number generation
type lockedRand struct {
    mu  sync.Mutex
    rng *rand.Rand
}

func newLockedRand() *lockedRand {
    return &lockedRand{
        rng: rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0)),
    }
}

func (r *lockedRand) Intn(n int) int {
    r.mu.Lock()
    defer r.mu.Unlock()
    return r.rng.IntN(n)
}
