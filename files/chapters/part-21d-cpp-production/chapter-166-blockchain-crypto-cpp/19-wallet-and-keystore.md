## Wallet and Keystore Engineering

A wallet is the user's interface to their on-chain assets. The technical core of a wallet is the keystore: how private keys are generated, stored, used, and protected. Hardware wallets (Ledger, Trezor, Coldcard, BitBox) are dominated by C and C++ firmware. Mobile and desktop software wallets often have C++ cores wrapped by Swift, Kotlin, or Electron front ends. This section covers BIP-32/39/44 hierarchical deterministic wallets, secure-enclave-backed keys, AEAD-encrypted keystores, and BIP-322 message signing.

### BIP-39 Mnemonic

A BIP-39 mnemonic is a human-readable encoding of 128 to 256 bits of entropy. Generation:

1. Sample 128 to 256 random bits.
2. Compute SHA-256 of the entropy, take the first `len/32` bits as a checksum.
3. Concatenate entropy and checksum.
4. Split into 11-bit chunks.
5. Map each chunk to a word in the BIP-39 wordlist (2048 English words by default).

```cpp
#include <sodium.h>
#include <array>
#include <string>
#include <vector>

class Bip39 {
public:
    static std::string generate_mnemonic(std::size_t entropy_bits) {
        if (entropy_bits != 128 && entropy_bits != 256) {
            throw std::invalid_argument("entropy must be 128 or 256");
        }
        std::vector<std::uint8_t> entropy(entropy_bits / 8);
        randombytes_buf(entropy.data(), entropy.size());
        return entropy_to_mnemonic(entropy);
    }

    static std::string entropy_to_mnemonic(std::span<const std::uint8_t> entropy) {
        std::array<std::uint8_t, 32> hash;
        crypto_hash_sha256(hash.data(), entropy.data(), entropy.size());
        std::size_t cs_bits = entropy.size() * 8 / 32;
        std::vector<std::uint8_t> bits(entropy.begin(), entropy.end());
        bits.push_back(hash[0]);  // checksum byte (only top cs_bits used)

        std::string out;
        std::size_t total_bits = entropy.size() * 8 + cs_bits;
        for (std::size_t i = 0; i < total_bits; i += 11) {
            std::uint16_t idx = 0;
            for (std::size_t j = 0; j < 11; ++j) {
                std::size_t b = i + j;
                std::uint8_t bit = (bits[b / 8] >> (7 - (b % 8))) & 1;
                idx = (idx << 1) | bit;
            }
            if (!out.empty()) out += ' ';
            out += wordlist[idx];
        }
        return out;
    }

    static std::array<std::uint8_t, 64>
    mnemonic_to_seed(std::string_view mnemonic, std::string_view passphrase = "") {
        std::string salt = "mnemonic";
        salt += passphrase;
        std::array<std::uint8_t, 64> seed;
        if (crypto_pwhash_scryptsalsa208sha256_ll(
                reinterpret_cast<const std::uint8_t*>(mnemonic.data()),
                mnemonic.size(),
                reinterpret_cast<const std::uint8_t*>(salt.data()),
                salt.size(),
                /* N */ 0, /* r */ 0, /* p */ 0,  // not used; we want PBKDF2
                seed.data(), seed.size()) != 0) {
            // fall back to PBKDF2-HMAC-SHA512 with 2048 iterations
        }
        return pbkdf2_hmac_sha512(mnemonic, salt, 2048);
    }

private:
    static const std::array<std::string, 2048> wordlist;
};
```

The mnemonic-to-seed step uses PBKDF2-HMAC-SHA512 with 2048 iterations. The salt is `"mnemonic" + passphrase`. The optional passphrase (BIP-39 calls it the "13th word" or "25th word") provides plausible deniability.

### BIP-32 Hierarchical Derivation

BIP-32 turns a 64-byte seed into a tree of derived keypairs. Each node in the tree has a 32-byte private key plus a 32-byte chain code. Children are derived deterministically from parent keys plus an index.

```cpp
struct ExtendedPrivKey {
    std::array<std::uint8_t, 32> key;
    std::array<std::uint8_t, 32> chain_code;
    std::uint8_t depth;
    std::uint32_t parent_fingerprint;
    std::uint32_t child_number;
};

ExtendedPrivKey master_from_seed(std::span<const std::uint8_t, 64> seed) {
    auto h = hmac_sha512(
        std::span{reinterpret_cast<const std::uint8_t*>("Bitcoin seed"), 12}, seed);
    ExtendedPrivKey out;
    std::memcpy(out.key.data(), h.data(), 32);
    std::memcpy(out.chain_code.data(), h.data() + 32, 32);
    out.depth = 0;
    out.parent_fingerprint = 0;
    out.child_number = 0;
    return out;
}

ExtendedPrivKey derive_child(const Context& ctx, const ExtendedPrivKey& parent, std::uint32_t i) {
    std::array<std::uint8_t, 37> data;
    if (i & 0x80000000u) {
        // hardened: H(0x00 || parent_priv || i)
        data[0] = 0;
        std::memcpy(data.data() + 1, parent.key.data(), 32);
    } else {
        // non-hardened: H(parent_pub_compressed || i)
        auto pub = derive_pubkey(ctx, parent.key);
        std::memcpy(data.data(), pub.data(), 33);
    }
    write_u32_be(std::span{data}.subspan(33, 4), i);
    auto h = hmac_sha512(parent.chain_code, data);

    ExtendedPrivKey child;
    std::memcpy(child.chain_code.data(), h.data() + 32, 32);
    // child key = parent_key + h[0..32] mod n
    secp256k1_ec_seckey_tweak_add(ctx.get(), parent.key.data(), h.data());
    std::memcpy(child.key.data(), parent.key.data(), 32);
    child.depth = parent.depth + 1;
    child.parent_fingerprint = compute_fingerprint(parent);
    child.child_number = i;
    return child;
}
```

BIP-44 specifies the conventional path layout: `m/44'/coin_type'/account'/change/index`. For Bitcoin coin_type=0, for Ethereum coin_type=60. The account index is hardened so it cannot be derived from a public key.

### Hardware Wallet Architecture

A hardware wallet's job is to keep the private key in a secure environment that the host computer cannot access, even when compromised. The typical architecture:

- **Secure element (SE)**: a chip with tamper-resistant key storage. Common chips: ST31, NXP A700x, Infineon SLE97. The SE generates and holds the master seed.
- **Microcontroller (MCU)**: STM32 or similar. Runs the firmware, drives the screen, handles USB.
- **Display**: shows transaction details for user confirmation.

The threat model: the host computer is fully compromised. The attacker can intercept and modify USB traffic. The wallet must display the true transaction details on its trusted screen and require physical button confirmation before signing.

C++ on hardware wallets:

- **Trezor**: written in C with Python on top for the UI. The newer Trezor Core uses MicroPython.
- **Ledger**: uses BOLOS, Ledger's proprietary OS. Apps are written in C, with a C++-style HAL provided by Ledger's SDK.
- **Coldcard**: written in C and MicroPython.
- **BitBox02**: written in C and Rust.

A senior C++ engineer working on a new hardware wallet has these constraints: no heap allocation (stack only), no exceptions, no STL containers, no libc beyond freestanding. The discipline is closer to embedded C than to application C++.

### Secure-Enclave-Backed Wallets

On modern phones and desktops, the hardware wallet's role can be partially filled by the device's built-in secure enclave: Apple's Secure Enclave Processor (SEP), Android's StrongBox, Windows Hello with TPM 2.0.

These enclaves typically store keys for native curves (NIST P-256), not secp256k1. To use them for crypto wallets, you have two options:

1. **Use the enclave key as a wrapping key**. Store the secp256k1 private key encrypted with an enclave-derived AEAD key. The enclave signs an AAD challenge to release the wrapping key. This is the approach of most software wallets on iOS and Android.
2. **Use the enclave key directly**. Some chains (e.g., Aptos passkey accounts, ERC-4337 with WebAuthn) accept P-256 signatures. The wallet's primary key is the enclave's P-256 keypair.

Option 2 is the future for many consumer wallets because the user does not need to back up a seed phrase: the key is bound to the device, and account recovery uses social recovery or guardians.

### AEAD-Encrypted Keystore

For software wallets that hold secp256k1 keys directly, the on-disk format is an AEAD-encrypted keystore. The Ethereum Foundation's web3 keystore v3 is the canonical example.

```cpp
struct KeystoreV3 {
    std::vector<std::uint8_t> ciphertext;
    std::array<std::uint8_t, 16> iv;
    std::array<std::uint8_t, 32> mac;
    std::string kdf;  // "scrypt" or "pbkdf2"
    KdfParams kdf_params;
    std::string cipher;  // "aes-128-ctr"
    std::string address;
    std::string id;  // UUID
    std::uint32_t version;  // 3
};

std::array<std::uint8_t, 32>
unlock_keystore(const KeystoreV3& ks, std::string_view password) {
    auto derived = derive_key(ks.kdf, ks.kdf_params, password);
    // Verify MAC
    std::array<std::uint8_t, 32> expected_mac;
    Sha256 h;
    h.update(std::span{derived.data() + 16, 16});
    h.update(ks.ciphertext);
    expected_mac = h.finalize();
    if (sodium_memcmp(expected_mac.data(), ks.mac.data(), 32) != 0) {
        throw std::runtime_error("bad password");
    }
    // Decrypt
    std::array<std::uint8_t, 32> private_key;
    aes_128_ctr_decrypt(
        std::span{derived.data(), 16}, ks.iv,
        ks.ciphertext, std::span{private_key.data(), private_key.size()});
    return private_key;
}
```

Two security pitfalls:

1. The web3 keystore v3 uses **AES-128-CTR plus a separate HMAC-SHA256 MAC**. This is "encrypt-then-MAC", which is correct, but the MAC is not over the IV. A motivated attacker can swap IVs. Modern wallets use AEAD (AES-GCM or ChaCha20-Poly1305) instead.
2. The KDF parameters must be strong enough to resist offline brute force. Use scrypt with `N >= 2^17` or Argon2id with at least 100MB memory. Older keystores often used `pbkdf2` with 1024 iterations, which is broken on a modern GPU.

### BIP-322 Message Signing

BIP-322 is the Bitcoin standard for signing arbitrary messages. The naive approach (sign `keccak256(message)` with the wallet key) is unsafe because it might collide with a transaction sighash and let an attacker construct a transaction that the wallet has "signed".

BIP-322 wraps the message in a virtual Bitcoin transaction structure that is unspendable (the output script forces failure when broadcast), and signs that virtual transaction. This guarantees no overlap with real transactions.

```cpp
std::array<std::uint8_t, 64>
sign_message_bip322(const Context& ctx, const PrivKey& sk,
                     const std::string& address, std::string_view message) {
    // Build to-spend virtual tx
    auto message_hash = tagged_hash("BIP0322-signed-message", message);
    CTransaction to_spend = build_to_spend(message_hash, address);
    // Build to-sign virtual tx
    CTransaction to_sign = build_to_sign(to_spend, address);
    // Sign as we would a real Taproot input
    auto sighash = compute_taproot_sighash(to_sign, 0, /* spent_amount */ 0,
                                            /* spent_script */ scriptpubkey_from(address));
    return crypto::schnorr::sign(ctx, sk, sighash, /* aux */ {});
}
```

### Senior Track Notes

- **PSBT (BIP-174)** is the standard for partially signed Bitcoin transactions. A senior wallet engineer must read and write PSBT correctly. The format supports multiple signers, hardware wallet workflows, and metadata for descriptors.
- **Output descriptors** (BIP-380 and friends) are the modern way to describe a wallet's address generation policy. A descriptor like `wpkh([fingerprint/path]xpub/0/*)` precisely defines the wallet without ambiguity. Old "extended public key" formats are descriptor-shaped but not formally specified.
- **Replace-by-fee (RBF) and child-pays-for-parent (CPFP)** are the two ways to bump fees on a stuck transaction. Wallet UX must surface both. Many real wallets get this wrong, leaving users stuck during fee spikes.
- **Multi-party computation wallets** (Fireblocks, Coinbase Custody, Copper) replace hardware wallets with threshold ECDSA or threshold Schnorr. The C++ relevance is the cryptographic core, which is similar to the FROST and MuSig2 protocols covered in section 04.

The next section drills into the performance engineering of blockchain core software.

---
