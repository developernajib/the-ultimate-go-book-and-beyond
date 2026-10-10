## Netcode and Determinism

Multiplayer netcode is the most misunderstood part of an engine, because the constraint is physics rather than engineering: a packet from London to New York takes about 35 ms one way at best, and no amount of code makes light faster. Every netcode model is a different way of lying about that gap convincingly.

### The Three Models

**Deterministic lockstep.** Send only inputs. Every client simulates every entity identically and the simulations stay in agreement. Bandwidth is tiny and independent of entity count, which is why RTS games with 20,000 units use it. The cost is absolute: the simulation must be **bit-exact deterministic across machines**, and one client cannot advance until everyone's inputs for that step arrive, so the slowest player sets everyone's latency.

**Snapshot interpolation.** The server simulates and broadcasts world state. Clients render slightly in the past (typically 100 ms) and interpolate between the snapshots they have. Simple, robust, no determinism requirement. This is the Quake lineage and most shooters. The cost is bandwidth proportional to visible entities, and a fundamental input latency of at least one round trip.

**Rollback (GGPO-style).** Predict remote inputs, simulate immediately, and when real inputs arrive that contradict the prediction, rewind and re-simulate the intervening frames. Local input feels instant, which is why fighting games use it. The cost is determinism plus a re-simulation budget: you may need to run 7 frames of simulation in one frame's time, so the sim must be fast enough to run 8x.

| Model | Sends | Determinism | Local input | Best for |
|-------|-------|-------------|-------------|----------|
| Lockstep | Inputs | Required, bit-exact | Delayed by RTT | RTS, many entities |
| Snapshot | State | Not required | Delayed by RTT | Shooters, MMOs |
| Rollback | Inputs | Required, bit-exact | Instant | Fighting games |

### What Bit-Exact Determinism Actually Requires

Two of the three models demand determinism, and engineers consistently underestimate what that means. The same input must produce **bit-identical** output on every machine, and the following will each break it:

**Floating point across compilers or architectures.** x87 80-bit intermediates, fused multiply-add contracting `a*b+c` into one instruction with different rounding, `-ffast-math` reassociating operations, and different `libm` implementations of `sin`/`cos` returning different last bits. The mitigations are strict IEEE 754 mode, no fast-math, no FMA contraction, and either your own transcendentals or lookup tables. Some studios use fixed-point arithmetic outright and accept the pain, because it is the only way to be certain.

**Iteration order.** Iterating a hash map keyed by pointer visits entities in an order that depends on the addresses the allocator returned, which differ per machine. Any reduction over that order (summing forces, resolving collisions) produces a different result. Deterministic simulations iterate dense arrays in index order, which is one more reason engines look like Chapter 160's sections 03 and 04.

**Uninitialized memory.** A field read before it is written is whatever was in that memory, which is a different value on each machine. Deterministic sims cannot tolerate a single one, and this is why they run with sanitizers permanently on in CI.

**Random numbers.** `rand()` is per-process state. Determinism requires a seeded PRNG whose stream is part of the simulation state and is saved, restored, and rolled back with it.

The engineering consequence is that determinism is not a feature you add. It is an invariant you maintain from day one, verified continuously, usually by running two simulations in CI and asserting their state hashes match every step. Teams that try to retrofit it onto a non-deterministic engine generally fail, and that is the fact worth knowing before you promise replays.

### Server Authority

Any model with untrusted clients needs the server to own the truth, because a client that computes its own position will eventually be a client that teleports.

```cpp
// The client predicts to hide latency, then reconciles when the
// authoritative server state arrives.
void onServerState(const ServerState& s) {
    // Server has processed our inputs up to s.lastProcessedInput.
    // Drop the ones it has already accounted for.
    pending.erase(pending.begin(),
                  pending.upper_bound(s.lastProcessedInput));

    if (distance(s.position, predictedAt(s.tick)) > kReconcileEpsilon) {
        // We mispredicted. Snap to the server, then replay the inputs
        // it has not seen yet so the player keeps their local responsiveness.
        state.position = s.position;
        for (const Input& in : pending) simulate(state, in, kFixedDt);
    }
}
```

This is client-side prediction with server reconciliation, and it is why your character moves the instant you press a key despite the server being 80 ms away. When the prediction is right, which is nearly always, nothing visible happens. When it is wrong, you get the rubber-band correction players complain about, and that complaint is the system working.

The security rule that follows: **the server validates, it does not trust**. Client sends inputs, never positions. A client that sends "I am at X" is a client that sends "I am inside your base."

### Junior to FAANG: Pick a Model From Requirements

The question is "how would you network a game like X?" and the answer is a derivation, not a preference.

Fighting game, two players, input latency is the entire experience: rollback. Local input must feel instant, and the entity count is small so re-simulating 8 frames is cheap.

RTS, 8 players, 20,000 units: lockstep. Snapshotting 20,000 entities is impossible bandwidth - inputs are a few bytes. Accept that the slowest player gates everyone.

Shooter, 64 players, cheating matters: server-authoritative snapshots with client prediction. Do not require determinism across 64 heterogeneous machines and do not trust any of them.

Name the cost in each case. An answer with no downside sounds like a memorized list.

### Senior at FAANG: Determinism Is an Architectural Commitment

The staff-level point is that determinism is a property of the whole codebase, enforced continuously or lost immediately, and it is a decision to make before writing the engine rather than after.

The verification mechanism is what makes it real: hash the simulation state every step and compare across clients (in dev builds) or across two runs (in CI). When the hashes diverge, you know the exact step, and then you bisect by hashing subsystems. Without that harness a desync is unfindable, because the symptom appears thousands of steps after the cause. Studios that ship deterministic games have this harness from the first month.

The reason it is a business decision rather than a technical one: determinism buys replays (a marketing and esports feature), rollback netcode (a genre-defining feel), server-side validation by re-simulation (an anti-cheat capability), and bug reports as input logs that reproduce exactly (a QA multiplier). Those four capabilities are worth a great deal, and they all come from the same invariant. But the invariant taxes every gameplay programmer forever: no `rand()`, no hash-map iteration in the sim, no fast-math, no uninitialized reads, and CI gates that fail the build for violations.

The ADR should say which capabilities you are buying and accept the tax explicitly, because retrofitting determinism later is a rewrite. That is the decision, and it belongs in month one.
