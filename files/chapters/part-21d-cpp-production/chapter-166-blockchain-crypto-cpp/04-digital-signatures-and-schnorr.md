## Digital Signatures and Schnorr

A digital signature scheme is the contract between a private key holder and the rest of the network. The scheme determines what malleability properties exist, whether signatures can be aggregated, what trust assumptions the verifier has, and how multi-party signing works. This section covers the four signature schemes a senior crypto engineer must understand: ECDSA, Schnorr (BIP340), MuSig2, and threshold signatures (FROST and BLS).

### ECDSA

ECDSA is the original signature scheme used by Bitcoin and Ethereum. It is defined over a generic elliptic curve and was standardized in FIPS 186-4. For Bitcoin and Ethereum, the curve is secp256k1.

The signing equation is:

```
k random in [1, n-1]
R = kG
r = R.x mod n
s = k^-1 (z + r*d) mod n
signature = (r, s)
```

Where `d` is the private key, `z` is the message hash, and `n` is the curve order.

Three things make ECDSA dangerous:

1. **Nonce reuse is catastrophic**. If you sign two different messages with the same `k`, an attacker can recover `d` by solving a 2-equation linear system. The Sony PlayStation 3 hack (2010) and several Bitcoin wallet hacks used this.
2. **Malleability**. For any valid signature `(r, s)`, the pair `(r, n-s)` is also valid. Bitcoin BIP-62 mandates the low-s form to prevent transaction malleability.
3. **No native aggregation**. You cannot combine N ECDSA signatures into one signature.

A correct ECDSA implementation uses RFC 6979 deterministic nonces and enforces low-s.

```cpp
#include <secp256k1.h>
#include <array>
#include <span>

namespace crypto::ecdsa {

std::array<std::uint8_t, 64>
sign(const Context& ctx,
     const PrivKey& sk,
     std::span<const std::uint8_t, 32> msg32) {
    secp256k1_ecdsa_signature sig;
    if (!secp256k1_ecdsa_sign(ctx.get(), &sig, msg32.data(), sk.data(),
                              secp256k1_nonce_function_rfc6979, nullptr)) {
        throw std::runtime_error("ecdsa sign failed");
    }
    // libsecp256k1 always produces low-s
    std::array<std::uint8_t, 64> compact;
    secp256k1_ecdsa_signature_serialize_compact(ctx.get(), compact.data(), &sig);
    return compact;
}

bool verify(const Context& ctx,
            const PubKeyCompressed& pk_bytes,
            std::span<const std::uint8_t, 32> msg32,
            std::span<const std::uint8_t, 64> sig_bytes) noexcept {
    secp256k1_pubkey pk;
    if (!secp256k1_ec_pubkey_parse(ctx.get(), &pk, pk_bytes.data(), pk_bytes.size())) {
        return false;
    }
    secp256k1_ecdsa_signature sig;
    if (!secp256k1_ecdsa_signature_parse_compact(ctx.get(), &sig, sig_bytes.data())) {
        return false;
    }
    return secp256k1_ecdsa_verify(ctx.get(), &sig, msg32.data(), &pk) == 1;
}

}  // namespace crypto::ecdsa
```

### Schnorr (BIP340)

Bitcoin Taproot (activated November 2021) introduced BIP340 Schnorr signatures, which fix every flaw of ECDSA:

- **Linear**. Signatures, public keys, and nonces are linear in the curve, which enables clean aggregation.
- **Provably secure under standard assumptions** (the discrete log assumption with the random oracle model).
- **64-byte signatures** instead of variable-length DER ECDSA (typically 71 to 72 bytes).
- **No malleability**. The signature is unique given a key and message.
- **x-only public keys**. Only the X coordinate is serialized, with Y parity normalized to even. This saves one byte per public key.

```cpp
#include <secp256k1_schnorrsig.h>

namespace crypto::schnorr {

std::array<std::uint8_t, 64>
sign(const Context& ctx,
     const PrivKey& sk,
     std::span<const std::uint8_t, 32> msg32,
     std::span<const std::uint8_t, 32> aux_rand) {
    secp256k1_keypair kp;
    if (!secp256k1_keypair_create(ctx.get(), &kp, sk.data())) {
        throw std::runtime_error("invalid sk");
    }
    std::array<std::uint8_t, 64> sig;
    if (!secp256k1_schnorrsig_sign32(
            ctx.get(), sig.data(), msg32.data(), &kp, aux_rand.data())) {
        throw std::runtime_error("schnorr sign failed");
    }
    return sig;
}

bool verify(const Context& ctx,
            std::span<const std::uint8_t, 32> xonly_pk,
            std::span<const std::uint8_t, 32> msg32,
            std::span<const std::uint8_t, 64> sig) noexcept {
    secp256k1_xonly_pubkey pk;
    if (!secp256k1_xonly_pubkey_parse(ctx.get(), &pk, xonly_pk.data())) return false;
    return secp256k1_schnorrsig_verify(
        ctx.get(), sig.data(), msg32.data(), 32, &pk) == 1;
}

}  // namespace crypto::schnorr
```

The `aux_rand` is 32 bytes of randomness mixed into the nonce derivation. BIP340 uses it to defend against fault attacks on hardware wallets. If you do not have a randomness source, pass 32 zero bytes. The signature is still secure (deterministic from the key and message), but slightly more vulnerable to fault injection on a tamperable device.

### MuSig2

MuSig2 is a 2-round multi-signature protocol where N parties cooperate to produce a single Schnorr signature that verifies under the aggregate public key. It is BIP327 and is supported in libsecp256k1 since version 0.4.

The protocol:

1. Each signer publishes a key. The aggregate key is computed deterministically.
2. Round 1: each signer publishes two nonce commitments.
3. Round 2: each signer computes a partial signature.
4. The coordinator sums the partial signatures into a final signature.

The naive 1-round Schnorr aggregation is vulnerable to the Wagner attack (a generalized birthday attack on the Fiat-Shamir transformation). MuSig2 needs two rounds to defeat it.

```cpp
#include <secp256k1_musig.h>

class MuSig2Signer {
public:
    MuSig2Signer(const Context& ctx, const PrivKey& sk, const std::vector<PubKeyCompressed>& cosigners)
        : ctx_(ctx) {
        // Aggregate keys
        std::vector<const secp256k1_pubkey*> pk_ptrs;
        std::vector<secp256k1_pubkey> pks;
        pks.reserve(cosigners.size());
        for (const auto& bytes : cosigners) {
            secp256k1_pubkey pk;
            secp256k1_ec_pubkey_parse(ctx_.get(), &pk, bytes.data(), bytes.size());
            pks.push_back(pk);
            pk_ptrs.push_back(&pks.back());
        }
        secp256k1_musig_pubkey_agg(
            ctx_.get(), nullptr, &agg_pk_, &cache_, pk_ptrs.data(), pk_ptrs.size());
        sk_ = sk;
    }

    // Round 1: produce nonce commitment
    std::array<std::uint8_t, 132> gen_nonce(std::span<const std::uint8_t, 32> msg32) {
        std::array<std::uint8_t, 32> session_id;
        // fill session_id with strong randomness
        secp256k1_musig_pubnonce pubnonce;
        secp256k1_musig_nonce_gen(
            ctx_.get(), &secnonce_, &pubnonce,
            session_id.data(), sk_.data(), nullptr,
            msg32.data(), nullptr, nullptr);
        std::array<std::uint8_t, 132> serialized;
        secp256k1_musig_pubnonce_serialize(ctx_.get(), serialized.data(), &pubnonce);
        return serialized;
    }

    // Round 2: produce partial sig given aggregated nonces
    std::array<std::uint8_t, 32> partial_sign(/* aggregated nonces, msg, etc. */);

private:
    const Context& ctx_;
    PrivKey sk_;
    secp256k1_xonly_pubkey agg_pk_;
    secp256k1_musig_keyagg_cache cache_;
    secp256k1_musig_secnonce secnonce_;
};
```

MuSig2 is the foundation of Lightning Network channel updates, federated Bitcoin sidechains (Liquid, Fedimint), and most modern Bitcoin multisig designs that want on-chain indistinguishability from a single-sig spend.

### BLS Aggregate Signatures

BLS signatures aggregate without interactivity. Any party can sum N signatures over the same message into one. Verification cost is one pairing plus N point additions on G1.

This is what makes Ethereum 2.0 work. A committee of 2048 validators each signs the same attestation, and the network only stores one 96-byte aggregate signature plus a 256-bit bitfield indicating which validators participated.

The verification routine from the previous section already shows the pattern. The senior-level detail is the **rogue key attack**: if you naively let users register public keys, an attacker can register `pk_attacker = pk_target^-1 * pk_attacker_real` and forge aggregate signatures. The defense is a **proof of possession** (PoP): every key registration requires a signature proving the user knows the private key. Ethereum 2.0 enforces this in the deposit contract.

### Threshold Signatures: FROST

FROST (Flexible Round-Optimized Schnorr Threshold signatures) is a t-of-n threshold scheme. Any t out of n participants can produce a Schnorr signature, but no smaller group can. It runs in two rounds and is compatible with BIP340 verification.

Use cases:

- **Custody**. Coinbase Custody and Fireblocks use threshold signatures so no single HSM can authorize withdrawals.
- **DAO multisig**. Replaces on-chain multisig with a single on-chain Schnorr signature, saving fees and providing privacy.
- **Bridge custodians**. Federated bridges (Liquid, Wormhole) use threshold schemes to prevent any single custodian from stealing funds.

```cpp
// Sketch only. Use a battle-tested implementation like ZF FROST or chill-frost.
class FrostParticipant {
public:
    FrostParticipant(int id, int threshold, int total);

    // Distributed key generation
    DkgRound1Output dkg_round1();
    DkgRound2Output dkg_round2(const std::vector<DkgRound1Output>& round1);
    void dkg_finalize(const std::vector<DkgRound2Output>& round2);

    // Signing
    NonceCommitment sign_round1();
    PartialSig sign_round2(
        std::span<const std::uint8_t, 32> msg,
        const std::vector<NonceCommitment>& commitments);

    // Aggregate
    static std::array<std::uint8_t, 64> aggregate(
        std::span<const std::uint8_t, 32> msg,
        const std::vector<NonceCommitment>& commitments,
        const std::vector<PartialSig>& partials);
};
```

The DKG (distributed key generation) is the hard part. A bad DKG can leak the long-term key. Use a verified implementation. Do not write your own.

### Senior Track Notes

- **ECDSA-versus-Schnorr at exchange scale**. Coinbase Exchange validates around 50,000 ECDSA signatures per second on hot wallets. The same hardware running Schnorr batch verify hits 200,000 per second. This is why exchanges that built on Bitcoin pre-Taproot are migrating cold storage to Taproot.
- **MuSig2 nonce reuse**. If a signer reuses a `secnonce` across two signing sessions, the private key is recoverable. The libsecp256k1 API destroys the secnonce after use to prevent this. Do not store the secnonce on disk. If your hardware wallet must persist signing state, you have a design problem.
- **Aggregation quirks**. BLS aggregation is over the same message (Ethereum 2.0 attestations) or different messages with extra hash domain separation. MuSig2 aggregates over the same message and same key set. FROST aggregates over the same message and same key. Mixing modes is a security bug.
- **FIDO2 and passkeys** use a different curve (P-256, also called secp256r1) and a different signature scheme. Do not confuse passkey signatures with Bitcoin signatures. The endianness conventions and signature encoding differ.

The next section moves to Merkle trees, which convert these signature primitives into the verifiable state machines that we call blockchains.

---
