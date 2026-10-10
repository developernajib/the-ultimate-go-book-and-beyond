## Cryptographic Primitives

Every blockchain protocol is a stack of cryptographic primitives glued together. If the primitives are wrong, nothing above them works. This section covers the building blocks: hashes, MACs, KDFs, and AEAD ciphers. The next two sections cover elliptic curves and signature schemes.

The C++ examples wrap libsodium and BoringSSL. Do not write your own cryptography in C++. Wrap a library that has been audited by professionals and has constant-time guarantees written into its build system.

### Hash Functions

A cryptographic hash function maps an arbitrary-length input to a fixed-length output with three properties: preimage resistance, second-preimage resistance, and collision resistance. In a blockchain context, hashes are used for:

- Block identifiers (Bitcoin uses double SHA-256, Ethereum uses Keccak-256).
- Transaction identifiers (txid in Bitcoin, hash in Ethereum).
- Merkle tree internal nodes.
- Address derivation (Bitcoin: RIPEMD160(SHA256(pubkey)), Ethereum: last 20 bytes of Keccak256(pubkey)).
- Proof-of-work (Bitcoin: double SHA-256, Ethereum's old Ethash, Litecoin's scrypt).

The hash function choice has consensus weight. Changing it requires a hard fork. Bitcoin's choice of SHA-256 in 2009 was based on FIPS 180-2 and NIST validation. Ethereum's choice of Keccak-256 (not the final SHA-3) was made before the SHA-3 standard was finalized in 2015, which is why Ethereum's hash differs from FIPS 202 by one byte in the padding.

#### Comparison Table

| Hash | Output | Throughput (single core, GB/s) | ASIC | Length extension |
|---|---|---|---|---|
| SHA-256 | 32 B | 0.5 | Yes (Bitcoin miners) | Vulnerable |
| SHA-3 (Keccak-256) | 32 B | 0.4 | No widespread | Resistant |
| BLAKE2b | 64 B | 1.0 | No | Resistant |
| BLAKE3 | 32 B (XOF) | 6.9 (AVX-512) | No | Resistant |

BLAKE3 is the fastest and is used in newer systems (Filecoin, some L2 commit hashes). SHA-256 is the most ASIC-accelerated, which matters for Bitcoin mining but not for consensus.

#### Wrapping libsodium for SHA-256

```cpp
#include <sodium.h>
#include <array>
#include <span>
#include <stdexcept>

namespace crypto {

class Sha256 {
public:
    using Digest = std::array<std::uint8_t, 32>;

    Sha256() {
        if (sodium_init() < 0) {
            throw std::runtime_error("libsodium init failed");
        }
        crypto_hash_sha256_init(&state_);
    }

    void update(std::span<const std::uint8_t> data) noexcept {
        crypto_hash_sha256_update(&state_, data.data(), data.size());
    }

    [[nodiscard]] Digest finalize() noexcept {
        Digest out{};
        crypto_hash_sha256_final(&state_, out.data());
        return out;
    }

    static Digest hash(std::span<const std::uint8_t> data) noexcept {
        Digest out{};
        crypto_hash_sha256(out.data(), data.data(), data.size());
        return out;
    }

private:
    crypto_hash_sha256_state state_{};
};

// Bitcoin uses double SHA-256 for txid and block hash.
[[nodiscard]] inline Sha256::Digest hash256(std::span<const std::uint8_t> data) noexcept {
    auto first = Sha256::hash(data);
    return Sha256::hash(first);
}

}  // namespace crypto
```

A few details that matter at L5+ review:

- The class is non-copyable by default through the contained `crypto_hash_sha256_state`. If you need copyability, add a copy constructor. SHA-256 state is just `uint32_t[8]` plus a length, so copy is cheap.
- `noexcept` on every method that does not throw. The compiler uses this to elide exception tables and inline more aggressively.
- `[[nodiscard]]` on `hash` and `finalize` because callers who throw away the digest have a bug.
- `std::span` rather than pointer-plus-length pairs. C++20 fixed this API for good.

#### Keccak-256 for Ethereum

Ethereum's `keccak256` is not in libsodium. Use `ethash` or copy the public-domain Keccak reference. `BoringSSL` exposes SHA-3 but not the Keccak variant Ethereum uses, since the SHA-3 standard changed the padding. The difference is one byte:

- Keccak-256 (Ethereum): pad with `0x01` then `0x80`.
- SHA3-256 (FIPS 202): pad with `0x06` then `0x80`.

A correct Ethereum address derivation is:

```cpp
#include <ethash/keccak.hpp>

std::array<std::uint8_t, 20> derive_address(std::span<const std::uint8_t, 64> pubkey_xy) {
    auto h = ethash::keccak256(pubkey_xy.data(), pubkey_xy.size());
    std::array<std::uint8_t, 20> addr;
    std::memcpy(addr.data(), h.bytes + 12, 20);
    return addr;
}
```

The pubkey here is the uncompressed 64-byte (X, Y) form, not the 65-byte form with the `0x04` prefix.

### HMAC

HMAC is a keyed message authentication code. In blockchains, it appears in:

- BIP-32 hierarchical deterministic wallets, where HMAC-SHA512 derives child keys.
- TLS handshakes for node-to-node encryption.
- Wallet password key derivation as one part of PBKDF2.

```cpp
#include <sodium.h>
#include <array>
#include <span>

[[nodiscard]] std::array<std::uint8_t, 64>
hmac_sha512(std::span<const std::uint8_t> key, std::span<const std::uint8_t> msg) noexcept {
    crypto_auth_hmacsha512_state state;
    crypto_auth_hmacsha512_init(&state, key.data(), key.size());
    crypto_auth_hmacsha512_update(&state, msg.data(), msg.size());
    std::array<std::uint8_t, 64> out;
    crypto_auth_hmacsha512_final(&state, out.data());
    return out;
}
```

The `state` is on the stack. For BIP-32 derivation of a deep path (m/44'/0'/0'/0/0) you call this five times in sequence. Each call is around 1 microsecond on a modern x86 core.

### Key Derivation Functions

A KDF turns a low-entropy password into a high-entropy key with deliberate computational cost. Three are common:

- **PBKDF2-HMAC-SHA512**: BIP-39 mnemonic-to-seed uses this with 2048 iterations. Cheap on GPU, cheap on ASIC. Acceptable only because the mnemonic itself has 128 to 256 bits of entropy.
- **scrypt**: memory-hard, used in Litecoin proof-of-work and some old wallet formats.
- **Argon2id**: memory-hard, side-channel resistant, the modern default. Won the Password Hashing Competition in 2015. Use it for any password-based wallet encryption today.

```cpp
#include <sodium.h>
#include <vector>
#include <span>

std::array<std::uint8_t, 32>
derive_key_argon2id(std::string_view password, std::span<const std::uint8_t, 16> salt) {
    std::array<std::uint8_t, 32> key{};
    if (crypto_pwhash(
            key.data(), key.size(),
            password.data(), password.size(),
            salt.data(),
            crypto_pwhash_OPSLIMIT_INTERACTIVE,
            crypto_pwhash_MEMLIMIT_INTERACTIVE,
            crypto_pwhash_ALG_ARGON2ID13) != 0) {
        throw std::runtime_error("argon2id OOM");
    }
    return key;
}
```

`OPSLIMIT_INTERACTIVE` and `MEMLIMIT_INTERACTIVE` target around 100ms and 64MB. For high-value wallet encryption, step up to `SENSITIVE`, which targets around 3 seconds and 1GB.

### AEAD: Authenticated Encryption

For wallet keystore files, encrypted communication, and any scenario where you encrypt data that an attacker can tamper with, use AEAD. Two algorithms cover every modern use case:

- **AES-256-GCM**: hardware-accelerated on x86 (AES-NI) and ARM (AES extensions). Fastest on modern hardware. Has a critical nonce-reuse-is-catastrophic property.
- **ChaCha20-Poly1305**: software-fast, constant-time on every CPU, used when AES hardware is missing or untrusted.

```cpp
#include <sodium.h>
#include <vector>
#include <span>
#include <stdexcept>

class Aead {
public:
    static constexpr std::size_t key_size = crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
    static constexpr std::size_t nonce_size = crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    static constexpr std::size_t tag_size = crypto_aead_xchacha20poly1305_ietf_ABYTES;

    explicit Aead(std::span<const std::uint8_t, key_size> key) noexcept {
        std::memcpy(key_.data(), key.data(), key_size);
    }

    ~Aead() {
        sodium_memzero(key_.data(), key_.size());
    }

    Aead(const Aead&) = delete;
    Aead& operator=(const Aead&) = delete;

    std::vector<std::uint8_t> seal(
        std::span<const std::uint8_t, nonce_size> nonce,
        std::span<const std::uint8_t> plaintext,
        std::span<const std::uint8_t> aad) const {
        std::vector<std::uint8_t> ct(plaintext.size() + tag_size);
        unsigned long long ct_len = 0;
        crypto_aead_xchacha20poly1305_ietf_encrypt(
            ct.data(), &ct_len,
            plaintext.data(), plaintext.size(),
            aad.data(), aad.size(),
            nullptr, nonce.data(), key_.data());
        ct.resize(ct_len);
        return ct;
    }

    std::vector<std::uint8_t> open(
        std::span<const std::uint8_t, nonce_size> nonce,
        std::span<const std::uint8_t> ciphertext,
        std::span<const std::uint8_t> aad) const {
        std::vector<std::uint8_t> pt(ciphertext.size());
        unsigned long long pt_len = 0;
        if (crypto_aead_xchacha20poly1305_ietf_decrypt(
                pt.data(), &pt_len,
                nullptr,
                ciphertext.data(), ciphertext.size(),
                aad.data(), aad.size(),
                nonce.data(), key_.data()) != 0) {
            throw std::runtime_error("AEAD auth failure");
        }
        pt.resize(pt_len);
        return pt;
    }

private:
    std::array<std::uint8_t, key_size> key_{};
};
```

XChaCha20-Poly1305 has a 24-byte nonce instead of 12, which lets you generate nonces randomly without fearing collision over the lifetime of a key. For high-value keys, this is the safer default.

The destructor calls `sodium_memzero`. The compiler is forbidden from optimizing this out, unlike a plain `std::memset`. If you wrote `std::memset(key_.data(), 0, key_.size())` and the compiler proved the memory was about to be deallocated, it would delete the memset. `sodium_memzero` uses a memory barrier and a volatile pointer write to defeat this optimization.

### Side Channels

A senior engineer must understand that constant time is not enforced by the C++ standard. A switch on a secret value, a table lookup at a secret-dependent index, or even a divide instruction with secret operands all leak through cache-timing or microarchitectural side channels.

The defensive practices are:

- Never branch on secret data.
- Never index into a table with a secret index.
- Use library APIs that document their constant-time properties (libsodium's `sodium_compare`, `sodium_is_zero`, libsecp256k1's everything).
- For comparison of MAC tags or signatures, use `sodium_memcmp`. Never use `std::memcmp` or `==` on `std::array`.

```cpp
bool verify_tag(std::span<const std::uint8_t, 16> a, std::span<const std::uint8_t, 16> b) noexcept {
    return sodium_memcmp(a.data(), b.data(), 16) == 0;
}
```

### Senior Track Notes

- **Bitcoin Core's choice of double SHA-256** is historical. SHA-256 alone is vulnerable to length-extension. Double-hashing was a quick defense in 2009 before SHA-3 existed. It costs roughly 2x the throughput of single SHA-256 in mining hardware, which is why ASIC vendors pipeline the two rounds.
- **BLAKE3's tree mode** lets you parallelize hashing across threads, which matters for Merkle trees of large blocks. A 1GB block hashed with BLAKE3 on 16 cores takes about 16ms, versus 250ms with SHA-256.
- **The libsodium ABI is stable across versions 1.0.18 and 1.0.19**, but the `crypto_pwhash` algorithm constants changed between Argon2i and Argon2id. If you ship a wallet, lock the algorithm constant in your serialized format. Do not rely on the libsodium default.

The next section moves from generic primitives to elliptic curves, which are where most consensus-critical code lives.

---
