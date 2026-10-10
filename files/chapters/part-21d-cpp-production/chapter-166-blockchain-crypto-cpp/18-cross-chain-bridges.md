## Cross-Chain Bridges

A bridge moves value or messages between blockchains. Bridges are the most attacked surface in crypto: more than \$2.5B has been stolen from bridges in 2021-2024 alone (Ronin, Wormhole, Nomad, Multichain, Harmony, Poly Network, BNB Bridge). A senior C++ engineer working on bridge infrastructure must understand the trust models, the verification logic, and the historical failure modes.

### Bridge Trust Models

Bridges fall into four categories by decreasing trust:

1. **Centralized custodian**. A single company holds the assets on chain A and issues a wrapped asset on chain B. WBTC is the canonical example. Trust: BitGo.
2. **Federated multi-signature**. A set of N custodians, of which T must sign. Examples: Wormhole (19 guardians, 13 of 19 threshold), the original Ronin bridge (9 validators, 5 threshold).
3. **Optimistic verification**. Anyone can claim a transfer is valid, if it is challenged within a window, a fraud proof is run. Example: Nomad, Hyperlane optimistic mode.
4. **Light-client verification**. The destination chain runs a light client of the source chain and verifies inclusion proofs cryptographically. Examples: IBC for Cosmos, zkBridge designs for Ethereum-to-X.

The strongest is light-client. The weakest in practice is federated multi-sig, because the threshold is usually small and the keys are operational secrets that have been stolen multiple times.

### Light-Client Bridges

A light client of chain A on chain B verifies block headers from chain A using the source chain's consensus rules. For Cosmos chains, this means verifying Tendermint signatures. For Ethereum, it means verifying the BLS-aggregated attestations of the sync committee (a 512-validator subset rotated every 256 epochs).

A C++ Ethereum sync-committee light client:

```cpp
struct SyncCommittee {
    std::array<BlsPubKey, 512> pubkeys;
    BlsPubKey aggregate_pubkey;
};

struct LightClientUpdate {
    BeaconBlockHeader attested_header;
    SyncCommittee next_sync_committee;
    std::vector<MerkleNode> next_sync_committee_branch;
    SyncAggregate sync_aggregate;
    Slot signature_slot;
};

class EthereumLightClient {
public:
    Result<void> apply_update(const LightClientUpdate& u) {
        // 1. Verify the participants count
        std::size_t participating = u.sync_aggregate.sync_committee_bits.popcount();
        if (participating < MIN_SYNC_COMMITTEE_PARTICIPANTS) {
            return Error{"insufficient participation"};
        }

        // 2. Build participating pubkey set
        std::vector<BlsPubKey> pks;
        for (std::size_t i = 0; i < 512; ++i) {
            if (u.sync_aggregate.sync_committee_bits.get(i)) {
                pks.push_back(current_sync_committee_.pubkeys[i]);
            }
        }

        // 3. Compute signing root
        auto signing_root = compute_signing_root(u.attested_header, u.signature_slot);

        // 4. BLS aggregate verify
        if (!bls::aggregate_verify(pks, signing_root, u.sync_aggregate.sync_committee_signature)) {
            return Error{"bad aggregate signature"};
        }

        // 5. Verify the next sync committee Merkle proof
        if (!verify_merkle_branch(
                hash_tree_root(u.next_sync_committee),
                u.next_sync_committee_branch,
                NEXT_SYNC_COMMITTEE_INDEX,
                u.attested_header.state_root)) {
            return Error{"bad next sync committee proof"};
        }

        // Update state
        if (u.attested_header.slot >= next_sync_committee_period_start_) {
            current_sync_committee_ = next_sync_committee_;
            next_sync_committee_ = u.next_sync_committee;
        }
        latest_finalized_header_ = u.attested_header;
        return {};
    }

private:
    SyncCommittee current_sync_committee_;
    SyncCommittee next_sync_committee_;
    BeaconBlockHeader latest_finalized_header_;
    Slot next_sync_committee_period_start_;
};
```

The BLS verification is the dominant cost. A single sync committee update verifies up to 512 signatures aggregated into one. The constant cost is one pairing on BLS12-381.

### Optimistic Bridges

An optimistic bridge does not verify on the destination chain. Instead, it allows a relayer to assert the source chain's state, and any observer can challenge the assertion within a fraud window (typically 7 days). If a challenge is upheld, the relayer's bond is slashed.

The challenge protocol is a fraud proof. For state-transition bridges, this is the same machinery used by optimistic rollups: bisect the disputed execution down to a single instruction, prove the correct result on-chain, and slash the cheater.

The risk is the **fraud window**. Funds are not finalized for 7 days. Bridge users typically use third-party fast-withdraw services that front the liquidity in exchange for a fee.

### zk Bridges

A zk bridge replaces the optimistic challenge with a succinct zero-knowledge proof of the source chain's state. The destination chain's verifier runs the zk verifier circuit (typically a Groth16 verifier in EVM) and accepts the source state if the proof is valid.

Production zk bridges in 2025:

- **Polyhedra zkBridge**: zkSNARK proofs of Ethereum sync committee signatures. Trustless and fast (proof posted once per sync committee period).
- **Succinct Labs SP1 light clients**: general-purpose zkVMs proving light client programs.
- **=nil. Foundation Proof Marketplace**: proof marketplace for cross-chain claims.

The C++ relevance is again at the prover level. The zk bridge prover does the same MSM and NTT work as a zkEVM, just with a smaller circuit (a sync committee verification circuit is around 1M constraints versus 50M+ for a zkEVM batch).

### Historical Disasters

A senior interview commonly asks about specific bridge hacks. The major incidents:

#### Ronin (March 2022, \$625M)

Sky Mavis's Axie Infinity bridge had 9 validators with a 5-of-9 threshold. An attacker compromised 4 validator nodes via spear-phishing and then used a backdoor in the Sky Mavis Discord bot to obtain the 5th key. The attacker drained 173,600 ETH plus 25.5M USDC.

Lesson: federated multi-sig with low threshold and centralized key management is a single point of failure. Threshold signatures with HSM-backed keys would have raised the bar significantly.

#### Wormhole (February 2022, \$326M)

Wormhole's Solana-to-Ethereum bridge had a flaw in the guardian signature verification: the program did not properly check that the input account passed to the verification routine was the canonical sysvar account. An attacker passed a fake sysvar containing a self-signed message, which the program accepted as valid.

Lesson: every input account in a Solana program must be validated by `pubkey == expected_pubkey`. Trusting account contents without verifying account identity is the most common Solana program bug.

#### Nomad (August 2022, \$190M)

Nomad's optimistic bridge had a configuration error: a routine update set the trusted root to `bytes32(0)`. As a result, every transfer's Merkle proof against the zero root succeeded trivially. Hundreds of opportunistic attackers piled in to drain the bridge over the course of an hour.

Lesson: configuration values that gate cryptographic verification must be initialized and immutably set. A zero default is the worst possible failure mode.

#### Multichain (July 2023, \$130M+)

Multichain's MPC keys were under unilateral control of the founder, who was arrested by Chinese authorities. The keys were inaccessible, and an "unauthorized" actor (likely an insider) drained funds.

Lesson: MPC threshold systems are only as good as the operational security of the participants. A single point of human failure breaks the cryptographic guarantee.

### C++ Bridge Relayer Architecture

A bridge relayer watches both chains, packages messages, and submits them across. The architecture:

```cpp
class BridgeRelayer {
public:
    void run() {
        watcher_a_thread_ = std::jthread([this](std::stop_token stop) {
            ChainAClient client(chain_a_endpoint_);
            std::uint64_t last_seen = load_checkpoint("a");
            while (!stop.stop_requested()) {
                auto events = client.poll_events(last_seen);
                for (const auto& e : events) {
                    if (e.kind == EventKind::OutboundMessage) {
                        outbound_queue_.push({ChainId::A, e});
                    }
                    last_seen = e.block_number;
                }
                save_checkpoint("a", last_seen);
                std::this_thread::sleep_for(std::chrono::seconds(1));
            }
        });
        // Symmetric watcher_b_thread_
        relay_thread_ = std::jthread([this](std::stop_token stop) {
            while (!stop.stop_requested()) {
                auto msg = outbound_queue_.pop_blocking();
                if (!msg) break;
                relay(*msg);
            }
        });
    }

private:
    void relay(const OutboundMessage& m) {
        auto proof = build_inclusion_proof(m);
        auto submit_tx = build_submit_tx(m, proof);
        auto receipt = destination_client_->submit(submit_tx);
        if (!receipt.success) {
            // retry queue with backoff
            retry_queue_.push_with_delay(m, std::chrono::seconds(30));
        }
    }

    std::jthread watcher_a_thread_;
    std::jthread watcher_b_thread_;
    std::jthread relay_thread_;
    BlockingQueue<OutboundMessage> outbound_queue_;
    DelayQueue<OutboundMessage> retry_queue_;
};
```

The reliability requirements are significant. A relayer that drops a message stalls user funds. A relayer that double-submits a message (after a partial failure) wastes gas. Idempotent submission via a unique message hash plus replay protection in the destination contract is mandatory.

### Senior Track Notes

- **IBC is the gold standard for trustless bridges** because it is light-client based with deterministic finality. The cost is that IBC requires both chains to support light-client verification of each other, which is hard to retrofit onto chains with non-trivial finality (Ethereum proof-of-stake) or no finality at all (Bitcoin).
- **LayerZero's "ULN" model** uses a separate oracle (DVN) and relayer with the requirement that they collude to forge a message. This is a configurable trust model: a security-conscious application can stack multiple DVNs to require multi-party collusion.
- **Replay protection across forks** is a subtle bridge concern. After Ethereum's Merge, several bridges had to add chain-ID checks to prevent transactions valid on Ethereum mainnet from being replayed on a forked chain.
- **Batched aggregate verification** is the future. A zk bridge that proves all of a day's outbound messages in one proof reduces per-message gas to near-zero. Polyhedra's roadmap and the "Universal zkLightClient" research direction both target this.

The next section moves into wallet engineering, where many of the same primitives are deployed at the user-facing edge.

---
