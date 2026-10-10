## Cosmos SDK, Tendermint, and ABCI++

Cosmos is a family of application-specific blockchains connected by the IBC (Inter-Blockchain Communication) protocol. The consensus engine is Tendermint Core (now CometBFT after the 2023 fork), a Byzantine fault tolerant algorithm with deterministic finality after one round in the common case. While Tendermint is written in Go, the application layer can be in any language, and there is a growing class of C++ application binaries connected via the ABCI++ protocol.

This section covers the consensus algorithm, the ABCI++ interface, and how a C++ application binary connects to a Go consensus engine.

### Tendermint / CometBFT in 200 Words

Tendermint is a partial-synchrony BFT consensus algorithm. Each block proceeds in rounds. A round has three phases: propose, prevote, precommit. A round leader (proposer) publishes a candidate block. Validators broadcast prevotes. If a validator sees +2/3 prevotes for the same block, it broadcasts a precommit. If a validator sees +2/3 precommits for the same block, the block is committed.

If a round fails (network partition, malicious proposer, timeout), the next round starts with a different proposer chosen from a deterministic schedule. As long as +2/3 of stake is honest and online, blocks finalize after one successful round.

Block time is typically 1 to 6 seconds. Throughput is bounded by the size of a block (around 1 MB) and the time to gossip and verify it. Cosmos Hub does roughly 1000 transactions per second peak.

### ABCI++

ABCI (Application BlockChain Interface) is the protocol between Tendermint and the application. ABCI++ (introduced in 2023) is the newer version with vote extensions and process-level proposal. The interface is a small set of methods:

- `InitChain`: called once at genesis.
- `PrepareProposal`: the proposer's chance to filter or reorder transactions before broadcasting the block proposal.
- `ProcessProposal`: validators evaluate whether the proposed block is acceptable.
- `BeginBlock`, `DeliverTx`, `EndBlock`, `Commit`: the classic block execution lifecycle.
- `ExtendVote` and `VerifyVoteExtension`: ABCI++ additions for cryptographic vote payloads.
- `Query`: read-only queries from clients.

Tendermint communicates with the application over a Unix domain socket or gRPC. The wire protocol is Protobuf-encoded ABCI messages.

### A C++ ABCI Application

```cpp
#include <abci.grpc.pb.h>
#include <grpc/grpc.h>
#include <grpcpp/server.h>
#include <grpcpp/server_builder.h>

class AbciApp final : public abci::ABCIApplication::Service {
public:
    grpc::Status InitChain(grpc::ServerContext* ctx,
                           const abci::RequestInitChain* req,
                           abci::ResponseInitChain* res) override {
        state_.initialize(req->initial_height(), req->validators());
        return grpc::Status::OK;
    }

    grpc::Status PrepareProposal(grpc::ServerContext* ctx,
                                 const abci::RequestPrepareProposal* req,
                                 abci::ResponsePrepareProposal* res) override {
        // Filter and reorder txs to fit the block size
        std::int64_t max_bytes = req->max_tx_bytes();
        std::int64_t used = 0;
        for (const auto& tx : req->txs()) {
            if (used + tx.size() > max_bytes) break;
            if (validate_for_proposal(tx)) {
                res->add_txs(tx);
                used += tx.size();
            }
        }
        return grpc::Status::OK;
    }

    grpc::Status ProcessProposal(grpc::ServerContext* ctx,
                                 const abci::RequestProcessProposal* req,
                                 abci::ResponseProcessProposal* res) override {
        for (const auto& tx : req->txs()) {
            if (!is_well_formed(tx)) {
                res->set_status(abci::ResponseProcessProposal::REJECT);
                return grpc::Status::OK;
            }
        }
        res->set_status(abci::ResponseProcessProposal::ACCEPT);
        return grpc::Status::OK;
    }

    grpc::Status FinalizeBlock(grpc::ServerContext* ctx,
                                const abci::RequestFinalizeBlock* req,
                                abci::ResponseFinalizeBlock* res) override {
        state_.begin_block(req->height(), req->time());
        for (const auto& tx : req->txs()) {
            auto* tx_res = res->add_tx_results();
            auto outcome = state_.deliver_tx(tx);
            tx_res->set_code(outcome.code);
            tx_res->set_data(outcome.data);
            tx_res->set_gas_wanted(outcome.gas_wanted);
            tx_res->set_gas_used(outcome.gas_used);
        }
        auto end_state = state_.end_block();
        res->set_app_hash(end_state.root_hash);
        return grpc::Status::OK;
    }

    grpc::Status Commit(grpc::ServerContext* ctx,
                         const abci::RequestCommit* req,
                         abci::ResponseCommit* res) override {
        auto root = state_.commit();
        res->set_data(root);
        return grpc::Status::OK;
    }

private:
    AppState state_;
};

int main() {
    AbciApp app;
    grpc::ServerBuilder builder;
    builder.AddListeningPort("0.0.0.0:26658", grpc::InsecureServerCredentials());
    builder.RegisterService(&app);
    auto server = builder.BuildAndStart();
    server->Wait();
}
```

The application maintains its own state machine. Tendermint provides ordering and finality guarantees. The application is responsible for the state transitions, the Merkle root computation, and the response codes.

### Determinism

The application must be **bit-for-bit deterministic**. The same input sequence on different validator nodes must produce the same `app_hash`. This means:

- No floating-point operations in state transitions.
- No iteration over `std::unordered_map` (use `std::map` or sorted vectors).
- No system time, no random numbers, no external IO during block execution.
- No multi-threaded execution unless the parallel scheduler is itself deterministic.

A non-determinism bug causes a chain halt: validators disagree on the `app_hash`, no block can be finalized, and the chain stops until the bug is patched and validators upgrade.

### IBC

IBC (Inter-Blockchain Communication) is Cosmos's cross-chain messaging protocol. Two chains exchange light-client headers and prove the inclusion of packets via Merkle proofs. The light client logic is consensus-critical: a bad light-client implementation can let a malicious counterparty inject fake packets.

The C++ relevance for IBC is that some non-Cosmos chains implement IBC light clients in C++ to participate in the Cosmos ecosystem. Polkadot's Composable Finance built a Substrate-side IBC implementation. Other chains are exploring similar bridges.

### CometBFT vs. Tendermint Core

In 2023, the Tendermint Core repository was forked and renamed CometBFT, maintained by the Informal Systems team and the Cosmos Hub validators. The protocol is unchanged. The fork was operational: a need to maintain the engine separately from the original company's roadmap. As of 2025, CometBFT is the canonical Cosmos consensus engine.

### Berachain BeaconKit

Berachain (launched 2025) introduced **BeaconKit**, an attempt to use Ethereum's Engine API as the boundary between consensus and execution in a Cosmos-style chain. BeaconKit runs the EVM execution layer (any standard Ethereum execution client) as the application, with CometBFT as the consensus layer.

This is architecturally interesting because it lets a Cosmos-style chain run any of the major EVM execution clients (Geth, Reth, Erigon, Silkworm) as the application binary. A C++ shop can run Silkworm as the BeaconKit execution layer.

### Senior Track Notes

- **ABCI++ vote extensions** enable application-defined data to be signed by validators. Use cases: oracle prices, MEV-free fair ordering protocols, light-client checkpoints. The C++ application populates the extension on `ExtendVote` and validates incoming extensions on `VerifyVoteExtension`.
- **The CometBFT light client** is intentionally simple: verify a sequence of block headers via signature thresholds. Production light clients use trust adjacency (each header must be signed by validators that overlap the previous trusted header by at least 1/3 voting power).
- **Cosmos SDK is Go-only**. The SDK provides modules for staking, governance, IBC, etc. A C++ application written directly against ABCI++ has to implement these modules itself, which is most of the value Cosmos SDK provides. The trade-off is full control over the state machine.
- **Slashing is the operational risk**. A validator that double-signs (signs two conflicting blocks at the same height) loses a percentage of its stake. A C++ ABCI application that has a determinism bug can cause its operator to be slashed if the bug causes a fork.

The next section drills into the Move VM, another C++-relevant runtime.

---
