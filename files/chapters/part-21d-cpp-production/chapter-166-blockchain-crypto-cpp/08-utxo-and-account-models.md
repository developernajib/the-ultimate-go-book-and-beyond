## UTXO and Account Models

How a blockchain represents state determines what kinds of transactions are possible, how parallel execution works, and how storage scales. The two dominant models are UTXO (Bitcoin) and account (Ethereum). Solana extends the account model with explicit rent and parallelism. Aptos and Sui use a resource-oriented model based on Move. A senior engineer must know the trade-offs of each.

### UTXO Model

In the UTXO model, the state is a set of unspent transaction outputs. Each output is `(txid, vout, amount, script)`. A transaction consumes some outputs (must reference them by `(txid, vout)`) and creates new ones. There is no notion of "balance", balance is derived by summing all UTXOs that the user can spend.

```cpp
struct OutPoint {
    Hash256 txid;
    std::uint32_t vout;

    bool operator==(const OutPoint&) const = default;
};

struct Coin {
    CAmount amount;
    CScript script_pubkey;
    std::uint32_t height;
    bool is_coinbase;
};

class UtxoSet {
public:
    [[nodiscard]] const Coin* get(const OutPoint& op) const {
        auto it = coins_.find(op);
        return it == coins_.end() ? nullptr : &it->second;
    }

    void spend(const OutPoint& op) {
        coins_.erase(op);
    }

    void add(const OutPoint& op, Coin coin) {
        coins_.emplace(op, std::move(coin));
    }

private:
    std::unordered_map<OutPoint, Coin, OutPointHasher> coins_;
};
```

Properties:

- **Inherently parallel verification**. Two transactions that consume disjoint UTXOs can be verified in any order. This is what makes Bitcoin block validation parallelize across CPU cores.
- **Stateless verification**. A transaction can be validated knowing only the spent UTXOs and the current block height. No global state is read.
- **Privacy**. Each output has a unique address (in modern wallets). Addresses do not have a persistent identity that links spends.
- **Replay protection** is built in. Replaying a transaction would require the same UTXOs to be unspent again, which is impossible.

Drawbacks:

- **No native programmability**. Bitcoin Script can verify a spend but cannot read the state of another address.
- **State growth is by output count**. Long-tail dust outputs accumulate forever (130 million UTXOs as of 2025).

### Account Model (Ethereum)

In the account model, state is a mapping from address to account. Each account has:

- **Nonce**: incremented on each transaction sent.
- **Balance**: in wei.
- **Code hash**: for contracts, hash of the deployed bytecode.
- **Storage root**: for contracts, root of the per-contract storage trie.

```cpp
struct Account {
    std::uint64_t nonce;
    uint256 balance;
    Hash256 code_hash;
    Hash256 storage_root;  // root of MPT for this account's storage
};

class StateDb {
public:
    [[nodiscard]] Account get_account(const Address& addr) const;
    void set_account(const Address& addr, const Account& acc);

    [[nodiscard]] uint256 get_storage(const Address& addr, const uint256& slot) const;
    void set_storage(const Address& addr, const uint256& slot, const uint256& value);

private:
    MerklePatriciaTrie state_trie_;
    std::unordered_map<Address, MerklePatriciaTrie> storage_tries_;
};
```

Properties:

- **Native programmability**. A contract can read and write any storage slot, call other contracts, and trigger events.
- **Compact balance representation**. One entry per account regardless of how many transactions it has received.
- **Replay attacks are prevented by the nonce**. Each transaction must increment the sender's nonce by exactly one.

Drawbacks:

- **Sequential execution by default**. Two transactions that touch the same contract conflict, and the EVM specification mandates serial execution within a block.
- **State bloat**. Every storage slot ever written persists until explicitly cleared. Ethereum's state size grew from 1 GB in 2018 to over 250 GB by 2025.

### Solana Account Model

Solana extends the account model with three twists:

1. **Every account is rent-exempt or pays rent**. An account must hold a minimum SOL balance proportional to its size (currently 0.00203928 SOL per byte for two years of rent). Accounts that fall below the threshold are garbage-collected.
2. **Transactions declare which accounts they read or write**. The runtime checks these declarations and uses them to schedule parallel execution (Sealevel).
3. **Programs are stateless**. A program is its own account holding code. Its state lives in separate "data accounts" that the program reads and writes via the runtime.

```cpp
struct SolanaAccount {
    std::uint64_t lamports;       // 1 SOL = 10^9 lamports
    std::vector<std::uint8_t> data;
    PublicKey owner;              // program that owns this account
    bool executable;
    std::uint64_t rent_epoch;
};

struct TransactionInstruction {
    PublicKey program_id;
    std::vector<AccountMeta> accounts;  // writable, readonly, signer flags
    std::vector<std::uint8_t> data;
};

class SealevelScheduler {
public:
    // Group instructions into parallel batches based on declared account access
    std::vector<std::vector<TransactionInstruction>>
    partition(std::span<const TransactionInstruction> txs) {
        std::vector<std::vector<TransactionInstruction>> batches;
        std::vector<std::unordered_set<PublicKey>> writes_per_batch;
        std::vector<std::unordered_set<PublicKey>> reads_per_batch;
        for (const auto& tx : txs) {
            std::size_t target = batches.size();
            for (std::size_t i = 0; i < batches.size(); ++i) {
                if (compatible(writes_per_batch[i], reads_per_batch[i], tx)) {
                    target = i;
                    break;
                }
            }
            if (target == batches.size()) {
                batches.emplace_back();
                writes_per_batch.emplace_back();
                reads_per_batch.emplace_back();
            }
            batches[target].push_back(tx);
            for (const auto& a : tx.accounts) {
                if (a.is_writable) writes_per_batch[target].insert(a.pubkey);
                else reads_per_batch[target].insert(a.pubkey);
            }
        }
        return batches;
    }
};
```

This is conceptually like Software Transactional Memory: declare what you touch, the scheduler arranges the rest. The downside is that programs must precisely declare account access, and a program that omits an account it actually touches is a runtime error rather than a soft failure.

### Aptos and Sui Resource Model

Move-based chains have a fundamentally different state model. There are no accounts as such. Instead, there are **resources**, which are typed values that live at specific addresses and can only be created, destroyed, and moved by their defining module.

A resource has linear semantics: it cannot be copied, only moved. This is enforced at the bytecode level by the Move verifier. The C++ implementation of the verifier (the original Diem implementation, before the move to Rust) had to track resource ownership across every bytecode path.

```move
// Move language pseudocode
module 0x1::Coin {
    struct Coin<phantom T> has store { value: u64 }

    public fun mint<T>(amount: u64): Coin<T> {
        Coin { value: amount }
    }

    public fun split<T>(c: Coin<T>, amount: u64): (Coin<T>, Coin<T>) {
        assert!(c.value >= amount);
        c.value = c.value - amount;
        let new = Coin { value: amount };
        (c, new)
    }
}
```

In C++ implementation terms, the runtime represents a resource as a tagged value with a type ID and a destructor that fires only if the value reaches the end of execution without being moved or stored. A resource that is dropped without being explicitly destroyed by its module is a runtime abort.

Sui Move adds **object IDs**: every object has a globally unique ID, and ownership is recorded at the object level rather than at the address level. This enables fine-grained parallelism: two transactions that touch disjoint object IDs can execute concurrently with no scheduler involvement.

### Senior Track Notes

- **UTXO state is naturally Merkle-summable**. The Bitcoin chainstate snapshot for assumeutxo is a single hash committing to the entire UTXO set. Ethereum's state root is also a single hash, but computing it is far more expensive due to the MPT structure.
- **Parallel execution of account-model chains** is the active research frontier. Block-STM (Aptos), Sealevel (Solana), and the various EIP-7503 proposals all attempt to extract parallelism from sequentially-defined transactions. The cost is more memory for conflict detection.
- **The "stateless client" research direction** uses Verkle trees plus block-included witnesses to let nodes validate without storing the state. This is a UTXO-like property bolted on top of an account model.
- **Storage rent debates**. Ethereum has resisted state rent because it complicates the developer model. Solana embraced it. NEAR also charges storage staking. The trade-off is developer convenience versus long-term state size.

The next section moves into the EVM, the most widely deployed bytecode interpreter in crypto.

---
