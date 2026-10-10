## Verified Cryptographic Libraries

Cryptography is the killer application of formal verification. Three reasons:

1. **The spec is unambiguous**. RFC 8439 (ChaCha20-Poly1305) defines exactly what bytes go in and out. There is no judgment call about correctness.
2. **The cost of a bug is catastrophic**. A side-channel leak or an off-by-one in a Curve25519 implementation breaks a billion connections.
3. **The code is small and pure**. Crypto primitives are typically a few hundred to a few thousand lines, with no dependencies, no allocation, and no I/O. This is exactly the shape verification can handle.

By 2026 the verified-crypto landscape includes HACL\*, EverCrypt, fiat-crypto, and several smaller projects, all shipping in production code paths used by hundreds of millions of users daily.

### HACL\*

HACL\* (High Assurance Cryptographic Library) is a verified implementation of cryptographic primitives written in F\* and extracted to C. From the Project Everest collaboration: INRIA Paris, Microsoft Research, CMU, and academic partners.

HACL\* covers:

- Symmetric: AES-GCM, ChaCha20-Poly1305, AES-CTR.
- Hashes: SHA-2 family, SHA-3, Blake2.
- MACs: HMAC, Poly1305.
- Asymmetric: Curve25519, Ed25519, P-256, RSA-PSS.
- KDFs: HKDF.

The proofs establish:

1. **Functional correctness**. Output matches the mathematical spec.
2. **Memory safety**. No buffer overflows, no use-after-free, no use of uninitialized memory.
3. **Secret-independent execution time**. Constant-time, immune to timing side channels.
4. **No secret-dependent memory access**. Immune to cache-timing attacks.

HACL\* ships in:

- **Mozilla NSS**, the crypto library inside Firefox and Thunderbird. ChaCha20-Poly1305 in NSS is HACL\*.
- **Linux kernel WireGuard**. Curve25519 implementation.
- **Microsoft Hyper-V**, components of the trusted boot chain.
- **mitls**, an experimental verified TLS implementation.
- **python-pyca/cryptography** has integrated some HACL\* primitives.

The integration model: HACL\* extracts to portable C, so your C++ project links it as a static library and calls through `extern "C"`. No need to deploy F\* or its toolchain in your build, only the verified C output.

### EverCrypt

EverCrypt is the **agile** and **multiplexed** layer on top of HACL\*. Agile means a single API supports multiple algorithm choices (e.g., one AEAD interface that dispatches to AES-GCM, ChaCha20-Poly1305, or AEGIS). Multiplexed means it picks the best implementation for the runtime CPU (AES-NI vs. portable, AVX2 vs. SSE4 vs. scalar).

EverCrypt's multiplexing logic is itself verified. The dispatcher cannot mistakenly call the AVX2 path on a CPU without AVX2.

```cpp
#include <EverCrypt_AEAD.h>

// agile API; works with any supported algorithm
EverCrypt_Error_error_code rc = EverCrypt_AEAD_create_in(
    Spec_Agile_AEAD_AES256_GCM, &state, key);
EverCrypt_AEAD_encrypt(state, iv, iv_len, ad, ad_len, plain, plain_len, cipher, tag);
```

This is the model serious verified-crypto deployment looks like in 2026: thin verified primitives plus a verified dispatcher, exposed through a stable C API that C++ code consumes.

### Project Everest

Project Everest is the umbrella for verified crypto and TLS work. Components:

- **HACL\***: verified primitives.
- **EverCrypt**: agile dispatcher.
- **Vale**: verified assembly for hot loops (AES-NI, GCM multiplication).
- **mitls**: verified TLS handshake and record layer.
- **EverParse**: verified parsers, used for Quic and TLS message parsing.

EverParse is particularly interesting: it generates verified C parsers from a high-level format description. Used in Microsoft's QUIC implementation (msquic) for parsing TLS frames. Eliminates a class of bugs (mis-parsed lengths, integer overflows in parsers) that have caused real CVEs.

### fiat-crypto

fiat-crypto (Andres Erbsen, MIT, ongoing) takes a different approach. Instead of writing C and proving it correct, fiat-crypto **generates** C from Coq specifications of finite-field arithmetic. The Coq definitions are the specification *and* the source of truth, the C is extracted output.

fiat-crypto generates the field arithmetic for:

- Curve25519 (X25519 ECDH).
- Curve P-256, P-384, P-521 (NIST curves).
- secp256k1 (Bitcoin/Ethereum).

Performance is competitive with hand-written C. The generated code ships in:

- **BoringSSL** (Google's OpenSSL fork). Most ECDH and signature curve arithmetic is fiat-crypto-generated.
- **Go's standard library** (`crypto/elliptic`).
- **Tor**, **Firefox NSS**, parts of **OpenSSL**.

The verification claim is strong: the C is correct *by construction*, because the Coq generator produces only correct programs from the high-level specification.

### Why Google chose BoringSSL with formal-leaning auditing

Google forked OpenSSL in 2014 after Heartbleed and named the result BoringSSL. The official line is "we want freedom to refactor", the unofficial reality is that OpenSSL was, and to a degree remains, hard to audit because of accumulated complexity.

BoringSSL's strategy is not full verification. It is:

1. **Aggressive simplification**. Remove options, configuration knobs, dead code.
2. **Tight code review**. Every change reviewed by a Google security engineer.
3. **Continuous fuzzing**. OSS-Fuzz runs on the codebase 24/7.
4. **Verified components where possible**. fiat-crypto for field arithmetic, HACL\* for some primitives.
5. **Constant-time discipline**. valgrind-based timing-leak checks, dudect, CT-grind.

The lesson for senior engineers: **partial verification of the highest-value components plus aggressive auditing of the rest** is often the right deployment, not full verification of everything.

### Constant-time and side-channel concerns

Functional correctness is necessary but not sufficient for crypto. A correct implementation that branches on the secret key leaks the key through timing. A correct implementation that indexes a table by the secret leaks through cache.

Verified crypto libraries include constant-time as a property:

- HACL\* proves secret-independent control flow and memory access.
- fiat-crypto generates branch-free, table-free arithmetic.
- Vale (verified assembly) handles AES-NI and GHASH where branchless instructions are essential.

Ad-hoc tools to check constant-time on unverified code:

- **dudect**: statistical timing analysis.
- **CT-grind / ctgrind**: valgrind-based, marks secret data and detects branches/loads on it.
- **MemSan / Pin-based tools**: detect data-dependent control flow.

For C++ crypto projects that are not verified, running ct-grind on every release is the minimum hygiene.

### How to consume verified crypto from C++

The pattern that works:

1. Identify the primitives you need (AES-GCM, Curve25519, etc.).
2. Pull HACL\* / EverCrypt as a static library, linked through `extern "C"`.
3. Wrap in a thin C++ RAII class that owns key material and zeroes on destruction.
4. Use the verified primitives for hot paths, fall back to OpenSSL/BoringSSL for less common algorithms.
5. Pin dependency versions. HACL\* is updated through the F\* extraction pipeline, regressions are rare but possible.

```cpp
#include <EverCrypt_AEAD.h>
#include <span>

class verified_aead {
    EverCrypt_AEAD_state_s* state_;
public:
    verified_aead(std::span<const uint8_t, 32> key) {
        EverCrypt_AEAD_create_in(
            Spec_Agile_AEAD_AES256_GCM,
            &state_,
            const_cast<uint8_t*>(key.data())
        );
    }
    ~verified_aead() { EverCrypt_AEAD_free(state_); }

    void encrypt(std::span<const uint8_t> iv,
                 std::span<const uint8_t> ad,
                 std::span<const uint8_t> plain,
                 std::span<uint8_t> cipher,
                 std::span<uint8_t, 16> tag) {
        // ... call EverCrypt
    }
};
```

The C++ wrapper is unverified. The crypto core is verified. Bugs in the wrapper (wrong nonce, key reuse, ad-hoc invariants) are still possible. This is why the wrapper itself should be small, code-reviewed, and ideally tested with property-based round-trip tests.

### Open issues

- **Quantum-resistant primitives**. ML-KEM, ML-DSA (CRYSTALS-Kyber, CRYSTALS-Dilithium standardized by NIST in 2024). Verified implementations are emerging but not yet at HACL\* maturity.
- **Hybrid TLS**. Combining classical and post-quantum KEMs. Spec churn makes verified implementations chase a moving target.
- **Hardware acceleration**. Verifying that an Intel SHA-NI sequence is functionally equivalent to scalar SHA-256 is non-trivial. Vale handles some cases.
- **Side channels at the microarchitectural level**. Spectre, Meltdown, and successors. Verified-against-the-ISA does not imply safe-against-microarchitecture. Active research.

### When to use verified crypto

For new C++ code in 2026, use HACL\* / EverCrypt by default for the algorithms it supports. Fall back to BoringSSL for algorithms HACL\* does not yet cover. Avoid OpenSSL for new code unless you have a specific compatibility requirement, the audit and fuzzing investment in BoringSSL is more focused.

If you are writing crypto yourself in C++, you have made a category error. Use a verified library. The number of C++ engineers who can write a constant-time, side-channel-resistant Curve25519 implementation correctly is small enough that "you" is statistically not in that set. This is also true of senior staff at FAANG, which is why FAANG ships fiat-crypto and HACL\*, not handwritten primitives.

> **Senior at FAANG.** When a service team proposes implementing a custom crypto primitive in C++, the answer is no. Either use the verified library, or hire a cryptographer and route the proposal through the security org. The history of "we just need a quick AES" in C++ is a history of CVEs. Decline politely and link them to HACL\*.
