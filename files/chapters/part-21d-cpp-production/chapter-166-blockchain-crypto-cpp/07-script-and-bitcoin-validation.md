## Bitcoin Script and Validation

Bitcoin Script is a stack-based, non-Turing-complete bytecode interpreted by every Bitcoin node. Every spend in Bitcoin runs the script, and the script's success or failure decides whether the spend is valid. This section covers the interpreter, the four major output types (P2PKH, P2SH, SegWit v0, Taproot), and the BIP340/341/342 verification logic.

### The Interpreter Loop

Bitcoin Script has roughly 100 opcodes, organized into:

- **Constants**: `OP_0`, `OP_1` through `OP_16`, `OP_PUSHDATA*`.
- **Flow control**: `OP_IF`, `OP_NOTIF`, `OP_ELSE`, `OP_ENDIF`.
- **Stack manipulation**: `OP_DUP`, `OP_DROP`, `OP_SWAP`, `OP_PICK`, etc.
- **Arithmetic**: `OP_ADD`, `OP_SUB`, plus comparison and boolean.
- **Cryptography**: `OP_HASH160`, `OP_HASH256`, `OP_CHECKSIG`, `OP_CHECKMULTISIG`, `OP_CHECKSIGADD`.

The interpreter at the top level:

```cpp
bool EvalScript(
    std::vector<std::vector<std::uint8_t>>& stack,
    const CScript& script,
    unsigned int flags,
    const BaseSignatureChecker& checker,
    SigVersion sig_version,
    ScriptExecutionData& exec_data,
    ScriptError* serror) {
    static constexpr int MAX_OPS_PER_SCRIPT = 201;
    static constexpr int MAX_STACK_SIZE = 1000;
    int op_count = 0;

    auto pc = script.begin();
    while (pc < script.end()) {
        opcodetype opcode;
        std::vector<std::uint8_t> push_data;
        if (!script.GetOp(pc, opcode, push_data)) return set_error(serror, SCRIPT_ERR_BAD_OPCODE);

        if (opcode > OP_16 && ++op_count > MAX_OPS_PER_SCRIPT) {
            return set_error(serror, SCRIPT_ERR_OP_COUNT);
        }

        switch (opcode) {
            case OP_DUP: {
                if (stack.empty()) return set_error(serror, SCRIPT_ERR_INVALID_STACK_OPERATION);
                stack.push_back(stack.back());
                break;
            }
            case OP_HASH160: {
                if (stack.empty()) return set_error(serror, SCRIPT_ERR_INVALID_STACK_OPERATION);
                auto& top = stack.back();
                Hash160 h = ripemd160(sha256(top));
                top.assign(h.begin(), h.end());
                break;
            }
            case OP_CHECKSIG: {
                if (stack.size() < 2) return set_error(serror, SCRIPT_ERR_INVALID_STACK_OPERATION);
                auto sig = stack[stack.size() - 2];
                auto pubkey = stack[stack.size() - 1];
                bool ok = checker.CheckECDSASignature(sig, pubkey, script, sig_version);
                stack.resize(stack.size() - 2);
                stack.push_back(ok ? std::vector<std::uint8_t>{1} : std::vector<std::uint8_t>{});
                break;
            }
            // ... 95 more opcodes ...
            default:
                return set_error(serror, SCRIPT_ERR_BAD_OPCODE);
        }

        if (stack.size() > MAX_STACK_SIZE) {
            return set_error(serror, SCRIPT_ERR_STACK_SIZE);
        }
    }
    return true;
}
```

The actual `EvalScript` in `src/script/interpreter.cpp` is around 1500 lines. The opcodes are in a single `switch` statement, which the compiler turns into a jump table. This is faster than function-pointer dispatch because the branch predictor can correlate adjacent opcodes.

### The Four Output Types

#### P2PKH (Pay-to-PubKey-Hash)

The original Bitcoin output type. The scriptPubKey is:

```
OP_DUP OP_HASH160 <pubkey-hash> OP_EQUALVERIFY OP_CHECKSIG
```

The scriptSig (now empty for SegWit, in legacy form) is:

```
<signature> <pubkey>
```

The script runs scriptSig followed by scriptPubKey on the same stack. The flow:

1. Push signature, push pubkey.
2. Duplicate pubkey.
3. Hash160 the duplicate.
4. Compare against the embedded hash. Fail if not equal.
5. Verify signature.

This was secure but inefficient. The witness data (signature, pubkey) was part of the txid, so any malleability of the signature changed the txid. SegWit fixed this.

#### P2SH (Pay-to-Script-Hash)

BIP-16, activated 2012. The scriptPubKey is:

```
OP_HASH160 <script-hash> OP_EQUAL
```

The scriptSig is `<args> <redeemScript>` where `redeemScript` is itself a Bitcoin Script. The validator hashes the redeemScript, compares against the embedded hash, and then evaluates the redeemScript with the args.

P2SH enables multisig and complex spending conditions to be committed to with a 20-byte hash, keeping fees low.

#### SegWit v0 (P2WPKH and P2WSH)

BIP-141, activated August 2017. The scriptPubKey is:

```
OP_0 <20-byte-hash>      # P2WPKH
OP_0 <32-byte-hash>      # P2WSH
```

The witness data lives in a separate witness stack outside the transaction's main body. The witness is excluded from the txid (fixing malleability) but included in the wtxid (used in the witness merkle tree).

Critically, SegWit changed the **sighash algorithm** from BIP-143. The new algorithm hashes commitments to inputs, outputs, and amounts in a specific order, allowing signers to compute sighashes in O(1) per input rather than O(n^2).

#### Taproot (SegWit v1)

BIP-340/341/342, activated November 2021. The scriptPubKey is:

```
OP_1 <32-byte-x-only-pubkey>
```

A Taproot output can be spent in two ways:

1. **Key path spend**: a single Schnorr signature against the visible 32-byte X-only public key. This is indistinguishable from a single-sig spend, even when the underlying spending policy is a complex multisig.
2. **Script path spend**: reveal one leaf of a Tapscript Merkle tree, plus the path proving it is committed to in the visible public key.

The visible public key is computed as:

```
P_visible = P_internal + tap_tweak * G
tap_tweak = taggedHash("TapTweak", P_internal || merkle_root)
```

Where `merkle_root` is the root of the Tapscript tree (or empty if no scripts).

```cpp
#include <secp256k1_extrakeys.h>

// Compute the tweaked output key
std::array<std::uint8_t, 32>
compute_taproot_output(const Context& ctx,
                       std::span<const std::uint8_t, 32> internal_xonly,
                       std::span<const std::uint8_t, 32> merkle_root) {
    secp256k1_xonly_pubkey internal;
    secp256k1_xonly_pubkey_parse(ctx.get(), &internal, internal_xonly.data());

    std::array<std::uint8_t, 32> tweak;
    auto h = tagged_hash("TapTweak");
    h.update(internal_xonly);
    h.update(merkle_root);
    tweak = h.finalize();

    secp256k1_pubkey output;
    secp256k1_xonly_pubkey_tweak_add(ctx.get(), &output, &internal, tweak.data());

    secp256k1_xonly_pubkey output_xonly;
    int parity;
    secp256k1_xonly_pubkey_from_pubkey(ctx.get(), &output_xonly, &parity, &output);

    std::array<std::uint8_t, 32> result;
    secp256k1_xonly_pubkey_serialize(ctx.get(), result.data(), &output_xonly);
    return result;
}
```

#### Tapscript

BIP-342 defines the script language used inside Taproot script-path spends. Differences from legacy Bitcoin Script:

- `OP_CHECKMULTISIG` is gone. Replaced by `OP_CHECKSIGADD` with a counter pattern, allowing batch verification.
- New `OP_CHECKSIG` uses Schnorr against an x-only key.
- New tagged sighash (BIP-341) commits to the entire transaction including SegWit annexes.
- Resource limits per input: 50 sigops budget, no per-script opcode limit (replaced by per-input weight limit).

A 1-of-3 Tapscript:

```
<pk1> OP_CHECKSIG
<pk2> OP_CHECKSIGADD
<pk3> OP_CHECKSIGADD
OP_1 OP_NUMEQUAL
```

The signer provides three signatures (or empty for no-signature) and the script counts the valid ones. This is batch-verification-friendly and roughly 30 percent cheaper than the legacy multisig.

### BIP-341 Sighash Computation

The Taproot sighash is the most carefully designed signature commitment in any blockchain. It commits to:

- Sighash flag.
- Genesis hash and version.
- Locktime.
- Hashes of all inputs (prev_outs, amounts, scripts, sequences) when SIGHASH_ALL.
- Hash of all outputs.
- Annex (if present).
- Spend type (key path or script path) and tap leaf hash (script path only).

```cpp
std::array<std::uint8_t, 32>
taproot_sighash(const CTransaction& tx,
                std::size_t input_index,
                const std::vector<CAmount>& spent_amounts,
                const std::vector<CScript>& spent_scripts,
                std::uint8_t hash_type,
                bool script_path,
                const uint256& tap_leaf_hash) {
    auto h = tagged_hash("TapSighash");
    h.update(std::span{&hash_type, 1});
    h.update(SerializeUint32LE(tx.nVersion));
    h.update(SerializeUint32LE(tx.nLockTime));
    h.update(SHA256OfPrevouts(tx));
    h.update(SHA256OfAmounts(spent_amounts));
    h.update(SHA256OfScripts(spent_scripts));
    h.update(SHA256OfSequences(tx));
    h.update(SHA256OfOutputs(tx));
    // spend type
    h.update(std::span{&spend_type, 1});
    h.update(SerializeUint32LE(input_index));
    if (script_path) {
        h.update(tap_leaf_hash);
        h.update(std::span<std::uint8_t, 1>{0x00});  // key version
        h.update(SerializeUint32LE(0xffffffff));     // codeseparator
    }
    return h.finalize();
}
```

The `spent_amounts` and `spent_scripts` parameters force the wallet to know the value of every UTXO it is spending. This breaks the old SIGHASH_NONE attack where a malicious node could trick a hardware wallet into signing a transaction with a different fee than displayed.

### Senior Track Notes

- **MAST (Merkelized Abstract Syntax Tree)** is the structure under Taproot script paths. The canonical encoding (BIP-340) sorts the children at each node lexicographically before hashing. This makes proof generation deterministic.
- **Sigops counting** is consensus-critical. A block has a hard limit of 80,000 sigops. Each ECDSA verify counts as 1, each `OP_CHECKMULTISIG` counts as up to 20. Tapscript uses a per-input budget instead of a global count.
- **Standardness vs. consensus**. The mempool enforces stricter rules than consensus. A transaction can be valid in a block but rejected from the mempool (and vice versa, though the latter is rare). This separation is in `src/policy/` and is the most common source of "my transaction was relayed but not mined" bugs.
- **The Tapscript validator is around 800 lines in `src/script/interpreter.cpp`**. It shares the EvalScript machinery with legacy script but has its own opcode subset and sighash function. Reading this code end to end is a good rite of passage for a Bitcoin Core contributor.

The next section moves up a level to the chain state model: UTXO versus account.

---
