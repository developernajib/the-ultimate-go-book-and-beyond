## Lean 4 and C++

Lean 4 is the proof assistant from Microsoft Research and the Lean FRO (Focused Research Organization), released as a stable language in 2023 and at version 4.10 by 2026. Unlike Coq and Isabelle, Lean 4 is also a **general-purpose programming language**: it compiles to native code, has a package manager (Lake), an LSP server, and a foreign function interface to C and C++.

The combination matters. Lean 4 is the first proof assistant where "proof" and "code" share infrastructure cleanly, which makes it the most plausible candidate for proof-carrying C++ in the medium term.

### Lean 4 as a language

```lean
def fib : Nat → Nat
  | 0 => 0
  | 1 => 1
  | n + 2 => fib n + fib (n + 1)

theorem fib_pos : ∀ n, n > 0 → fib n > 0 := by
  intro n hn
  induction n with
  | zero => contradiction
  | succ k ih =>
    cases k with
    | zero => decide
    | succ j => simp [fib]; omega
```

`def` defines functions, `theorem` defines proofs, both live in the same module. `by` enters tactic mode. `omega` is a decision procedure for linear arithmetic over integers, equivalent in power to `lia` in Coq.

Lean 4's elaborator is itself written in Lean 4 (self-hosted), and macros let users extend the language syntax cleanly. This is why mathlib4 has been able to grow to over 1.5 million lines of mathematics by 2026.

### Mathlib4

Mathlib4 is the community-driven mathematical library. By 2026 it covers:

- All undergraduate analysis, algebra, topology, number theory.
- Graduate algebraic geometry (perfectoid spaces, étale cohomology fragments).
- Category theory and higher categories.
- Probability, measure theory, functional analysis.
- Algorithm correctness lemmas (sorting, graph algorithms).

The relevance to engineering: mathlib4 is the proof that a proof assistant *can* serve as a shared engineering substrate at scale. Hundreds of mathematicians and engineers refactor and rebase a single library daily, with CI checking proofs on every PR. That is the workflow successful verified-engineering projects need.

### Dependent types

Lean 4 has full dependent types. A type can depend on a value:

```lean
def Vec (α : Type) (n : Nat) : Type := { l : List α // l.length = n }

def head : (v : Vec α (n + 1)) → α
  | ⟨[], h⟩ => absurd h (by simp)
  | ⟨a :: _, _⟩ => a
```

`Vec α n` is the type of lists of length exactly `n`. `head` cannot be called on an empty vector because the type system rules it out. This is the static analogue of the runtime checks idiomatic C++ requires.

Dependent types are how you encode rich invariants directly into types, removing whole classes of runtime checks. The cost is annotation complexity. Languages like Idris, Agda, and F\* explore this design space. Lean 4 has the most active engineering community.

### FFI to C and C++

Lean 4 compiles to C, which links against any C++ runtime. Calling C from Lean 4:

```lean
@[extern "c_strlen"] opaque c_strlen : @& String → UInt64

def main : IO Unit := do
  let s := "hello"
  IO.println s!"length = {c_strlen s}"
```

```c
// stub.c
#include <lean/lean.h>
#include <string.h>

uint64_t c_strlen(b_lean_obj_arg s) {
    return strlen(lean_string_cstr(s));
}
```

Build with Lake:

```toml
-- lakefile.lean
package lean_ffi {
  extraDepTargets := #[`stub_o]
  moreLinkArgs := #["-L.", "-lstub"]
}
```

The implication for C++ verification: you can write proven Lean 4 code, extract or directly compile it, and call it from C++. fiat-crypto follows this pattern in Coq, generating verified field arithmetic exposed through C headers used by BoringSSL and curl.

### Lean 4 for engineering specs

Three patterns emerging by 2026:

#### 1. Specs as Lean 4 modules

Write the specification of a C++ module in Lean 4, generate the spec as documentation, and verify the C++ implementation conforms via property-based testing seeded from Lean 4 enumerators. This is the approach of several formal-methods consultancies (Galois Inc., Trail of Bits) for client work where full proof is too expensive.

#### 2. Verified algorithms extracted to C++

Implement the algorithm in Lean 4, prove correctness, extract to C, wrap in C++. The fiat-crypto model. Active for crypto, less so for general algorithms because Lean's runtime is reference-counted and not as fast as hand-written C++.

#### 3. Lean 4 as a model checker for distributed protocols

Apalache and TLA+ remain dominant, but Lean 4 with `decide` and `omega` has been used to encode small protocols and prove safety properties manually. Niche, growing.

### Lean Copilot and AI assistance

Lean Copilot (Yang et al., released 2024) integrates LLMs into Lean tactic mode:

```lean
example (n : Nat) : n + 0 = n := by
  search_proof  -- LLM suggests `simp` or `rfl`
```

Combined with Lean 4's proof reconstruction (the LLM proposes a tactic, the kernel verifies), Lean Copilot is the most credible AI-for-proofs deployment as of 2026. Other tools:

- **LeanDojo** (Caltech): a benchmark and dataset of mathlib4 proofs for training proof-search models.
- **GPT-f** (OpenAI, 2020) was the early demonstration. Modern successors are Anthropic's Claude with theorem-proving fine-tunes and DeepMind's AlphaProof.
- **Aesop** is Lean 4's automated proof search tactic, classical in approach (best-first search), often combined with LLM suggestions.

The current frontier: AlphaProof reached IMO silver medal performance in 2024 by combining Lean 4 with reinforcement learning on synthetic proof data. The same techniques apply to engineering verification: invariant synthesis is the bottleneck, and ML-guided search is starting to crack it.

### What stays human

Even with AI assistance, the **specification** stays human. No model can write the spec for you because the spec encodes intent. The model can fill in tactics, suggest invariants, and discharge SMT goals. It cannot tell you what the program is supposed to do.

This is the durable role of the human verification engineer in 2026 and beyond: write correct specs, decompose complex theorems into manageable lemmas, and keep the proof maintainable.

### Concrete recommendation for C++ teams

For a C++ team curious about formal methods in 2026:

1. **Start with TLA+** for design-level protocol specification. Cheapest entry, highest ROI for distributed systems.
2. **Add CBMC** for memory-safety proofs on parsers and crypto-adjacent code.
3. **Try Lean 4** for a small, well-defined algorithm, with extraction to C and FFI from C++.
4. **Reserve Coq or Isabelle** for crypto, compilers, kernels where the existing community and infrastructure dominate.

Lean 4 is the most pleasant of the four to learn in 2026. The toolchain is fast, the IDE integration is good, and the ecosystem is growing. If your team is going to commit to one proof assistant for the next decade, Lean 4 has the strongest momentum.

> **Senior at FAANG.** Lean 4 is where the formal methods community is moving for new work. Mathlib4 has crossed the line from research curiosity to durable infrastructure, and Lean Copilot demonstrates that AI-assisted proofs are not vapour. If your org has a formal methods budget, it is rational to spend a fraction of it on Lean 4 fluency now, before the talent market reflects the shift.
