## Zero-Knowledge Proofs in C++

A zero-knowledge proof lets one party (the prover) convince another (the verifier) that a statement is true without revealing why. In blockchain, the statement is usually "this batch of transactions executes correctly to produce this new state root", and the proof lets a Layer 1 verify a Layer 2 batch in milliseconds rather than re-executing the entire batch.

This section covers the four major proof systems used in production today: Groth16, PlonK, Halo2, and STARKs. All four have C++ touchpoints, even when the high-level prover is in Rust.

### Vocabulary

- **SNARK**: Succinct Non-interactive ARgument of Knowledge. Short proofs, fast verification. Most need a trusted setup.
- **STARK**: Scalable Transparent ARgument of Knowledge. No trusted setup. Larger proofs, post-quantum security claim.
- **Trusted setup**: a one-time ceremony to generate public parameters. If the toxic waste is leaked, an attacker can forge proofs. Multiparty computation (MPC) ceremonies make this practically secure.
- **Universal setup**: one trusted setup works for any circuit up to a size bound. PlonK introduced this.
- **Transparent setup**: no trusted setup at all. STARKs and Halo2 (with IPA) achieve this.
- **Recursion**: a proof that verifies another proof. Enables proof aggregation and incrementally verifiable computation.

### Groth16

Groth16 is the original zk-SNARK. It produces 192-byte proofs and verifies in 3 pairing evaluations (about 3 ms on a single core). The downsides are a per-circuit trusted setup and limited expressiveness (R1CS constraints only).

The C++ canonical implementation is `libsnark`, written by SCIPR Lab and used by the original Zcash. The library structure:

```cpp
// libsnark API sketch
#include <libsnark/zk_proof_systems/ppzksnark/r1cs_gg_ppzksnark/r1cs_gg_ppzksnark.hpp>

using namespace libsnark;
using ppT = libff::default_ec_pp;

void prove_example() {
    libff::default_ec_pp::init_public_params();

    protoboard<libff::Fr<ppT>> pb;
    pb_variable<libff::Fr<ppT>> x, y, out;
    x.allocate(pb, "x");
    y.allocate(pb, "y");
    out.allocate(pb, "out");
    pb.add_r1cs_constraint(r1cs_constraint<libff::Fr<ppT>>(x, y, out), "x*y=out");
    pb.set_input_sizes(1);

    auto cs = pb.get_constraint_system();
    auto keypair = r1cs_gg_ppzksnark_generator<ppT>(cs);

    // Set witness
    pb.val(x) = 3;
    pb.val(y) = 5;
    pb.val(out) = 15;

    auto proof = r1cs_gg_ppzksnark_prover<ppT>(keypair.pk, pb.primary_input(), pb.auxiliary_input());
    bool ok = r1cs_gg_ppzksnark_verifier_strong_IC<ppT>(keypair.vk, pb.primary_input(), proof);
    assert(ok);
}
```

In production, no one writes circuits in `libsnark` directly. The circuit is compiled from a high-level DSL (Circom, Noir, Cairo, ZoKrates) into R1CS, and the prover backend takes that R1CS plus the witness. The C++ relevance is that the prover backend itself is often C++ for performance.

### PlonK and KZG Commitments

PlonK (Permutations over Lagrange-bases for Oecumenical Noninteractive arguments of Knowledge) is the dominant SNARK of the late 2020s. Its key properties:

- **Universal trusted setup**. One ceremony works for circuits up to a size bound.
- **KZG commitments**. Polynomial commitments over BN254 or BLS12-381.
- **Succinct proofs**. Around 500 bytes plus a few field elements.
- **Custom gates**. Beyond R1CS, PlonK supports custom gate types that reduce circuit size for common patterns (range checks, lookups).

The KZG commitment scheme is the same primitive used in Ethereum's EIP-4844 blob transactions. The C++ implementation is `c-kzg-4844`, originally written by the Ethereum Foundation and ported to multiple language bindings.

```cpp
// c-kzg-4844 API
#include <c_kzg_4844.h>

void prove_blob_inclusion(KZGSettings* s, const Blob& blob, Bytes32 z) {
    KZGCommitment commitment;
    blob_to_kzg_commitment(&commitment, &blob, s);

    KZGProof proof;
    Bytes32 y;
    compute_kzg_proof(&proof, &y, &blob, &z, s);

    // Verifier
    bool ok;
    verify_kzg_proof(&ok, &commitment, &z, &y, &proof, s);
}
```

The `KZGSettings` is loaded from a 16 MB `trusted_setup.txt` file. The Ethereum Foundation ran a multi-party ceremony in 2023 with over 140,000 participants. As long as one participant was honest, the toxic waste is unrecoverable.

### Halo2

Halo2 (developed by Electric Coin Company for Zcash Orchard) eliminates the trusted setup entirely. It uses **inner product arguments (IPA)** for polynomial commitments, which are transparent at the cost of slower verification (logarithmic instead of constant in circuit size).

Halo2's headline contribution is **recursion via accumulation**. A proof can incorporate the verification of a previous proof without doing a full pairing-based verifier in-circuit. This enables practical IVC (incrementally verifiable computation), where each step of a long computation is proven and the proof is aggregated into the running state.

The reference implementation is in Rust. The C++ relevance is the GPU acceleration backends (cuda-fixnum, ICICLE, Filecoin's GPU MSM) that the prover offloads heavy work to.

### STARKs

STARKs (Scalable Transparent ARguments of Knowledge) use hash-based commitments (typically Reed-Solomon plus FRI) instead of elliptic curve pairings. Key properties:

- **No trusted setup**.
- **Post-quantum**. Hash-based assumptions are conjectured secure against quantum attackers.
- **Large proofs**. 50 to 500 KB per proof, much larger than SNARKs.
- **Fast prover with native arithmetization**. STARK arithmetization (AIR) maps cleanly to register-machine computations.

StarkWare's Cairo VM (used by StarkNet) is the production STARK system. The Cairo prover (Stone) is open source. Polygon's Plonky2 and Plonky3 are also STARK-like systems with unusually small proofs (10 to 50 KB) by combining FRI with PlonK arithmetization.

### Circuit DSLs

Production zk systems compile from a high-level DSL to a constraint system. The major DSLs:

- **Circom**: language-level, R1CS output. Used by Iden3, Polygon zkEVM, Hermez, many academic projects.
- **Cairo**: full programming language with STARK backend. Used by StarkNet.
- **Noir**: Aztec's DSL, PlonK-style backend.
- **Halo2 hand-written**: experts write circuits directly in Rust against the Halo2 API. Used by zkSync, Scroll, and the Zcash Orchard pool.
- **Plonky2/3 hand-written**: similar Rust-direct style.

The C++ touchpoint with these DSLs is the **witness generator**. Witness generation runs the program with concrete inputs and produces the assignment of every wire in the circuit. For Circom this is a C++ program emitted by the compiler:

```cpp
// Generated by circom for circuit `my_circuit.circom`
extern "C" int run(struct WitnessCalc* wc) {
    // Field operations using GMP
    Fr_str2element(&signal[0], "input_value");
    // ... thousands of field operations ...
    return 0;
}
```

Witness generation for a 10-million-constraint circuit can take 30 seconds, often longer than proving time on GPU.

### Choosing a Proof System

The decision matrix:

| Goal | System |
|---|---|
| Smallest proof, fast verifier | Groth16 |
| Universal setup, custom gates | PlonK / Halo2-KZG |
| No trusted setup, recursion | Halo2 with IPA |
| Post-quantum, no setup | STARK / Plonky2 |
| EVM-compatible verifier on Ethereum L1 | Groth16 / PlonK / Halo2-KZG |

Most L2s in 2025 use a PlonK or Halo2 variant. zkSync uses Boojum (Halo2-style FRI). Scroll uses Halo2-KZG. Polygon zkEVM uses Plonky2 + Groth16 wrapper. Linea uses PlonK + Vortex.

### C++ Performance Hot Paths

For a senior C++ engineer on a prover team, the work concentrates in three areas:

1. **MSM (Multi-Scalar Multiplication)**. The dominant cost in pairing-based SNARKs. Algorithms: Pippenger's bucketing, GLV decomposition, Edwards form transformation. C++ implementations link CUDA kernels for GPU acceleration.
2. **NTT/FFT**. The dominant cost in STARK provers and PlonK quotient computation. C++ implementations use radix-4 or radix-8 butterflies, plus hardware FFT cards (Cysic, Ulvetanna, Ingonyama Z1).
3. **Field arithmetic**. The base layer. Optimized for the specific curve (BN254, BLS12-381, Goldilocks for STARKs). C++ uses inline assembly for `addcq`, `mulx`, and Barrett reduction.

```cpp
// Example: Pippenger MSM sketch
#include <vector>

template <typename G, typename Scalar>
G msm_pippenger(const std::vector<G>& bases, const std::vector<Scalar>& scalars) {
    constexpr int c = 16;  // window size
    constexpr int num_windows = 256 / c;
    std::array<G, (1 << c)> buckets{};

    G result = G::identity();
    for (int w = num_windows - 1; w >= 0; --w) {
        for (auto& b : buckets) b = G::identity();
        for (std::size_t i = 0; i < scalars.size(); ++i) {
            std::uint32_t idx = (scalars[i] >> (w * c)) & ((1 << c) - 1);
            if (idx) buckets[idx] = buckets[idx] + bases[i];
        }
        G window_sum = G::identity();
        G running = G::identity();
        for (int j = (1 << c) - 1; j > 0; --j) {
            running = running + buckets[j];
            window_sum = window_sum + running;
        }
        for (int s = 0; s < c; ++s) result = result.double_in_place();
        result = result + window_sum;
    }
    return result;
}
```

Real implementations vectorize the inner loop with AVX-512 or push the entire MSM to a CUDA kernel.

### Senior Track Notes

- **A senior interview question** at any zk team is "explain the cost breakdown of producing a proof for a 1M-constraint circuit". Expected answer: witness generation 5 to 10 seconds, MSM 60 to 80 percent of remaining time, NTT 15 to 25 percent, polynomial evaluation and Fiat-Shamir hashing under 5 percent.
- **GPU acceleration is mandatory** for any prover targeting throughput. ICICLE (Ingonyama) is the open-source standard. CUDA kernels for BN254 and BLS12-381 are available. Production teams write their own optimized kernels for the specific curve and constraint system.
- **Verifier-on-EVM** is a critical product concern. A Groth16 verifier is around 250k gas. A PlonK verifier is around 350k gas. A STARK verifier on EVM is several million gas, which is why STARK chains use a SNARK-of-STARK wrapper for L1 settlement.
- **Side-channel safety** is harder than in classical crypto because the witness contains secret data and the prover does many operations on it. Constant-time field arithmetic and constant-memory-access MSM are emerging requirements for prover-as-a-service deployments.

The next section drills into the rollup prover systems where these primitives are deployed at scale.

---
