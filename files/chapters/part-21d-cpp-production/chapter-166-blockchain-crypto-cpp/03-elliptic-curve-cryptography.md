## Elliptic Curve Cryptography

Every major blockchain rests on three curves: secp256k1 (Bitcoin, Ethereum, most legacy chains), Ed25519 (Solana, Cardano, NEAR, Aptos, Sui), and BLS12-381 (Ethereum 2.0 consensus, Filecoin, Aleo, Mina). A senior crypto engineer must know the security level, performance characteristics, and library landscape for all three.

### What an Elliptic Curve Is in Practice

An elliptic curve over a finite field defines a group of points where you can add two points and multiply a point by a scalar. The discrete logarithm problem on this group (given `P` and `kP`, recover `k`) is computationally hard. Public-key cryptography uses this asymmetry: the secret is `k`, the public key is `kG` where `G` is a fixed generator.

For a blockchain engineer, three numbers matter for each curve:

- **Security level in bits** (the cost of breaking the discrete log).
- **Scalar field size** (bit length of valid private keys).
- **Group law cost** (cycles per scalar multiplication on a modern x86 core).

| Curve | Security | Scalar bits | secp mult (cycles) | Use case |
|---|---|---|---|---|
| secp256k1 | 128 | 256 | 50,000 | Bitcoin, Ethereum |
| Ed25519 | 128 | 253 | 80,000 | Solana, Aptos, Sui |
| BLS12-381 G1 | 128 | 255 | 200,000 | Ethereum 2.0 |
| BLS12-381 G2 | 128 | 255 | 600,000 | Ethereum 2.0 |

The ratio matters. A Bitcoin block validation does roughly 5,000 secp256k1 verifies. An Ethereum 2.0 epoch does over 1,000,000 BLS verifies, which is why BLS aggregation is mandatory.

### secp256k1 and libsecp256k1

Bitcoin Core extracted its elliptic curve code into a standalone library called `libsecp256k1`. It is the most carefully written piece of cryptographic code in the open source world. The design decisions are worth studying because they apply to any high-assurance C++ code:

- **Pure C, no C++**. The library is C99 with no STL, no exceptions, no allocations on the verification path. C++ code links it as a thin extern "C" wrapper.
- **No undefined behavior**. The library compiles cleanly under UBSan, ASan, and MSan. Every multiplication is checked for overflow against the modulus.
- **Constant-time scalar multiplication**. The window method is implemented with conditional moves only. There is no data-dependent branch, no data-dependent memory access, and no data-dependent timing.
- **Endomorphism-accelerated multiplication**. secp256k1 has a fast endomorphism that splits a 256-bit scalar into two 128-bit halves, which roughly halves the multiplication cost. Bitcoin Core enabled this in 2020 after the patent expired.
- **Optional precomputed tables**. The signing path uses a 64KB table for the generator. The verification path uses a smaller table. Both are computed at context initialization and never modified.

#### C++ Wrapper

```cpp
#include <secp256k1.h>
#include <secp256k1_recovery.h>
#include <secp256k1_schnorrsig.h>

#include <array>
#include <span>
#include <stdexcept>
#include <memory>

namespace crypto::secp {

struct ContextDeleter {
    void operator()(secp256k1_context* c) const noexcept {
        secp256k1_context_destroy(c);
    }
};

class Context {
public:
    Context()
        : ctx_(secp256k1_context_create(SECP256K1_CONTEXT_SIGN | SECP256K1_CONTEXT_VERIFY)) {
        if (!ctx_) throw std::runtime_error("secp256k1 ctx alloc");
        std::array<std::uint8_t, 32> seed{};
        if (auto* f = std::fopen("/dev/urandom", "rb")) {
            std::fread(seed.data(), 1, 32, f);
            std::fclose(f);
        }
        secp256k1_context_randomize(ctx_.get(), seed.data());
    }

    [[nodiscard]] secp256k1_context* get() const noexcept { return ctx_.get(); }

private:
    std::unique_ptr<secp256k1_context, ContextDeleter> ctx_;
};

using PrivKey = std::array<std::uint8_t, 32>;
using PubKeyCompressed = std::array<std::uint8_t, 33>;
using Sig = std::array<std::uint8_t, 64>;

PubKeyCompressed derive_pubkey(const Context& ctx, const PrivKey& sk) {
    secp256k1_pubkey pk;
    if (!secp256k1_ec_pubkey_create(ctx.get(), &pk, sk.data())) {
        throw std::runtime_error("invalid private key");
    }
    PubKeyCompressed out;
    std::size_t out_len = out.size();
    secp256k1_ec_pubkey_serialize(
        ctx.get(), out.data(), &out_len, &pk, SECP256K1_EC_COMPRESSED);
    return out;
}

}  // namespace crypto::secp
```

A few things to note for senior review:

- `secp256k1_context_randomize` is called after creation. This is a side-channel countermeasure. It blinds the precomputed tables with a fresh random scalar so that a multi-tenant cloud attacker cannot extract keys via flush-and-reload cache attacks. Bitcoin Core re-randomizes the context every signature.
- The compressed public key form is 33 bytes: one prefix byte (0x02 or 0x03 indicating Y parity) plus 32 bytes of X. The uncompressed form is 65 bytes (0x04 || X || Y) and is only used in legacy contexts.
- The `Context` is expensive to construct. In a server, create one per thread and reuse it.

#### Batch Verification

When validating a Bitcoin block during initial block download, you have thousands of signatures to verify. Sequential verification at 50,000 cycles per signature is too slow. libsecp256k1 supports batch verification of Schnorr signatures (BIP340), which uses random linear combinations to verify N signatures in roughly N/sqrt(N) time. Bitcoin Core 24.0+ uses this for Taproot blocks.

```cpp
#include <secp256k1_schnorrsig.h>

bool batch_verify_schnorr(
    const Context& ctx,
    std::span<const std::array<std::uint8_t, 64>> sigs,
    std::span<const std::array<std::uint8_t, 32>> msgs,
    std::span<const secp256k1_xonly_pubkey> keys) {
    auto* scratch = secp256k1_scratch_space_create(ctx.get(), 1 << 20);
    // ... build pointer arrays ...
    bool ok = secp256k1_schnorrsig_verify_batch(
        ctx.get(), scratch, sigs.data(), msgs.data(), keys.data(), sigs.size());
    secp256k1_scratch_space_destroy(ctx.get(), scratch);
    return ok;
}
```

The scratch space is a per-thread arena allocator that the library uses to avoid `malloc` in the verify path.

### Ed25519

Ed25519 is the curve used by Solana, Cardano, NEAR, Aptos, and Sui. It is also used by SSH and TLS 1.3. The reference implementation is `ref10` by Bernstein, integrated into libsodium and BoringSSL.

Key properties:

- **Deterministic signing**. The nonce is derived from `HMAC-SHA512(seed, message)`, so the same key and message always produce the same signature. This eliminates the `k` reuse vulnerability that plagued ECDSA in Sony PlayStation 3 and several Bitcoin wallets.
- **Twisted Edwards curve**. The group law has a single addition formula that works for all input pairs, including identity. There are no special cases to mishandle.
- **Cofactor 8**. There are subtle interactions with the cofactor that have caused real bugs (the Monero Ed25519 double-spend attack of 2017 exploited it). Solana uses cofactored verification (multiplied by 8) to avoid this class of bug.

```cpp
#include <sodium.h>
#include <array>
#include <span>

namespace crypto::ed25519 {

using PrivKey = std::array<std::uint8_t, crypto_sign_SECRETKEYBYTES>;  // 64
using PubKey = std::array<std::uint8_t, crypto_sign_PUBLICKEYBYTES>;   // 32
using Sig = std::array<std::uint8_t, crypto_sign_BYTES>;               // 64

std::pair<PubKey, PrivKey> generate() {
    PubKey pk;
    PrivKey sk;
    crypto_sign_keypair(pk.data(), sk.data());
    return {pk, sk};
}

Sig sign(const PrivKey& sk, std::span<const std::uint8_t> msg) {
    Sig sig;
    crypto_sign_detached(sig.data(), nullptr, msg.data(), msg.size(), sk.data());
    return sig;
}

bool verify(const PubKey& pk, std::span<const std::uint8_t> msg, const Sig& sig) noexcept {
    return crypto_sign_verify_detached(sig.data(), msg.data(), msg.size(), pk.data()) == 0;
}

}  // namespace crypto::ed25519
```

Solana validators verify Ed25519 signatures using a GPU pipeline. CUDA implementations of Ed25519 batch verify achieve over 1 million signatures per second on a single GPU, which is what allows Solana to sustain 50,000 transactions per second in burst.

### BLS12-381

BLS12-381 is a pairing-friendly curve. The group has a bilinear pairing `e: G1 x G2 -> GT` that enables aggregate signatures, threshold signatures, and SNARK proofs. The curve was selected by Zcash in 2017 and adopted by Ethereum 2.0 in 2020.

The C++ libraries are:

- **blst**: Supranational's optimized assembly implementation. Used by every major Ethereum 2.0 client.
- **mcl**: Mitsunari's library, used by EOS and some research projects.
- **gnark-crypto**: Go library, used by Polygon zkEVM, also has C bindings.

```cpp
#include <blst.h>
#include <array>
#include <span>

namespace crypto::bls {

using SkBytes = std::array<std::uint8_t, 32>;
using PkBytes = std::array<std::uint8_t, 48>;   // G1 compressed
using SigBytes = std::array<std::uint8_t, 96>;  // G2 compressed

PkBytes derive_pubkey(const SkBytes& sk_bytes) {
    blst_scalar sk;
    blst_scalar_from_bendian(&sk, sk_bytes.data());
    blst_p1 pk;
    blst_sk_to_pk_in_g1(&pk, &sk);
    PkBytes out;
    blst_p1_compress(out.data(), &pk);
    return out;
}

SigBytes sign(const SkBytes& sk_bytes, std::span<const std::uint8_t> msg) {
    static constexpr char dst[] = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
    blst_scalar sk;
    blst_scalar_from_bendian(&sk, sk_bytes.data());
    blst_p2 hash;
    blst_hash_to_g2(&hash, msg.data(), msg.size(),
                    reinterpret_cast<const std::uint8_t*>(dst), sizeof(dst) - 1,
                    nullptr, 0);
    blst_p2 sig;
    blst_sign_pk_in_g1(&sig, &hash, &sk);
    SigBytes out;
    blst_p2_compress(out.data(), &sig);
    return out;
}

bool aggregate_verify(
    std::span<const PkBytes> pks,
    std::span<const std::uint8_t> common_msg,
    const SigBytes& agg_sig) {
    static constexpr char dst[] = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
    blst_p1_affine agg_pk{};
    blst_p1 acc{};
    for (const auto& pk : pks) {
        blst_p1_affine pk_aff;
        if (blst_p1_uncompress(&pk_aff, pk.data()) != BLST_SUCCESS) return false;
        blst_p1 pk_proj;
        blst_p1_from_affine(&pk_proj, &pk_aff);
        blst_p1_add_or_double(&acc, &acc, &pk_proj);
    }
    blst_p1_to_affine(&agg_pk, &acc);

    blst_p2_affine sig_aff;
    if (blst_p2_uncompress(&sig_aff, agg_sig.data()) != BLST_SUCCESS) return false;

    return blst_core_verify_pk_in_g1(
        &agg_pk, &sig_aff, true,
        common_msg.data(), common_msg.size(),
        reinterpret_cast<const std::uint8_t*>(dst), sizeof(dst) - 1,
        nullptr, 0) == BLST_SUCCESS;
}

}  // namespace crypto::bls
```

Ethereum 2.0 attestation verification aggregates the signatures of an entire committee (up to 2048 validators) into a single G2 point. The aggregate verification cost is one pairing plus the cost of summing the public keys, which scales linearly in the number of validators but the dominant cost (the pairing) is constant.

### Senior Track Notes

- **The libsecp256k1 module system** lets you compile in only the features you need. Bitcoin Core uses ECDSA, recovery, ECDH, and Schnorr. A wallet might only need ECDSA and BIP-32. Trim unused modules to reduce attack surface.
- **Ed25519 has two flavors of verification**. The classic `verify` does cofactor-aware checks. The `verify_strict` rejects non-canonical encodings. Solana uses strict verification to ensure transaction non-malleability. If you write a Solana validator component, do not use the loose API.
- **BLS12-381 hash-to-curve is consensus-critical**. The DST (domain separation tag) above must match exactly across all clients. Ethereum 2.0 specifies it in the consensus spec, and a single byte difference would fork the network.
- **Side-channel hardening varies by library**. blst is constant-time on the verification path but has data-dependent branches in some signing paths. Audit your library before using it in a hardware security module or air-gapped signer.

The next section moves from curves to the signature schemes built on top of them.

---
