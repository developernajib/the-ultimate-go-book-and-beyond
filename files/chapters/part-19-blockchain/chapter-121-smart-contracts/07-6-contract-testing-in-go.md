## 121.6 Contract Testing in Go

Testing smart contract interactions is crucial. The simulated backend provides a local blockchain for testing.

### 6.1 Simulated Backend Setup

go-ethereum's `SimulatedBackend` gives tests an in-process chain: deploy contracts, mine blocks on demand, and assert on state, all without a node or a network.
```go
package contract_test

import (
    "context"
    "math/big"
    "testing"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/accounts/abi/bind/backends"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/stretchr/testify/require"

    "myproject/contracts/token"
)

// TestEnvironment holds test fixtures
type TestEnvironment struct {
    Backend    *backends.SimulatedBackend
    Owner      *bind.TransactOpts
    User1      *bind.TransactOpts
    User2      *bind.TransactOpts
    OwnerAddr  common.Address
    User1Addr  common.Address
    User2Addr  common.Address
}

// SetupTest creates a test environment
func SetupTest(t *testing.T) *TestEnvironment {
    // Generate test keys
    ownerKey, err := crypto.GenerateKey()
    require.NoError(t, err)

    user1Key, err := crypto.GenerateKey()
    require.NoError(t, err)

    user2Key, err := crypto.GenerateKey()
    require.NoError(t, err)

    // Get addresses
    ownerAddr := crypto.PubkeyToAddress(ownerKey.PublicKey)
    user1Addr := crypto.PubkeyToAddress(user1Key.PublicKey)
    user2Addr := crypto.PubkeyToAddress(user2Key.PublicKey)

    // Create genesis allocation (fund accounts with ETH)
    alloc := core.GenesisAlloc{
        ownerAddr: {Balance: big.NewInt(10000000000000000000)}, // 10 ETH
        user1Addr: {Balance: big.NewInt(10000000000000000000)}, // 10 ETH
        user2Addr: {Balance: big.NewInt(10000000000000000000)}, // 10 ETH
    }

    // Create simulated blockchain
    gasLimit := uint64(8000000)
    backend := backends.NewSimulatedBackend(alloc, gasLimit)

    // Create transactors
    chainID := big.NewInt(1337) // Simulated chain ID

    owner, err := bind.NewKeyedTransactorWithChainID(ownerKey, chainID)
    require.NoError(t, err)

    user1, err := bind.NewKeyedTransactorWithChainID(user1Key, chainID)
    require.NoError(t, err)

    user2, err := bind.NewKeyedTransactorWithChainID(user2Key, chainID)
    require.NoError(t, err)

    return &TestEnvironment{
        Backend:   backend,
        Owner:     owner,
        User1:     user1,
        User2:     user2,
        OwnerAddr: ownerAddr,
        User1Addr: user1Addr,
        User2Addr: user2Addr,
    }
}

// Commit mines a new block
func (env *TestEnvironment) Commit() {
    env.Backend.Commit()
}
```

### 6.2 Complete Test Suite

The test suite uses `go-ethereum`'s `backends.SimulatedBackend` to deploy contracts against an in-memory EVM and calls `Commit()` to mine a block after each transaction, making tests fully deterministic without network access. `testify/require` is used for assertion failures that should abort the test immediately, while `assert` is used for non-fatal checks that accumulate all failures in one test run.

```go
package contract_test

import (
    "context"
    "math/big"
    "testing"
    "time"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "myproject/contracts/token"
)

func TestTokenDeployment(t *testing.T) {
    env := SetupTest(t)
    defer env.Backend.Close()

    // Deploy contract
    initialSupply := big.NewInt(1000000)
    addr, tx, contract, err := token.DeployToken(env.Owner, env.Backend, initialSupply)
    require.NoError(t, err)

    // Mine the deployment transaction
    env.Commit()

    // Verify deployment
    receipt, err := env.Backend.TransactionReceipt(context.Background(), tx.Hash())
    require.NoError(t, err)
    assert.Equal(t, uint64(1), receipt.Status)
    assert.NotEqual(t, common.Address{}, addr)

    // Verify initial state
    name, err := contract.Name(&bind.CallOpts{})
    require.NoError(t, err)
    assert.Equal(t, "MyToken", name)

    // Verify owner has initial supply
    balance, err := contract.BalanceOf(&bind.CallOpts{}, env.OwnerAddr)
    require.NoError(t, err)
    assert.Equal(t, initialSupply.String(), balance.String())
}

func TestTokenTransfer(t *testing.T) {
    env := SetupTest(t)
    defer env.Backend.Close()

    // Deploy
    initialSupply := big.NewInt(1000000)
    _, _, contract, err := token.DeployToken(env.Owner, env.Backend, initialSupply)
    require.NoError(t, err)
    env.Commit()

    // Transfer amount
    transferAmount := big.NewInt(1000)

    // Check balances before
    ownerBalBefore, err := contract.BalanceOf(&bind.CallOpts{}, env.OwnerAddr)
    require.NoError(t, err)

    user1BalBefore, err := contract.BalanceOf(&bind.CallOpts{}, env.User1Addr)
    require.NoError(t, err)

    // Transfer
    tx, err := contract.Transfer(env.Owner, env.User1Addr, transferAmount)
    require.NoError(t, err)
    env.Commit()

    // Verify transaction success
    receipt, err := env.Backend.TransactionReceipt(context.Background(), tx.Hash())
    require.NoError(t, err)
    assert.Equal(t, uint64(1), receipt.Status)

    // Check balances after
    ownerBalAfter, err := contract.BalanceOf(&bind.CallOpts{}, env.OwnerAddr)
    require.NoError(t, err)

    user1BalAfter, err := contract.BalanceOf(&bind.CallOpts{}, env.User1Addr)
    require.NoError(t, err)

    // Verify balances changed correctly
    expectedOwnerBal := new(big.Int).Sub(ownerBalBefore, transferAmount)
    assert.Equal(t, expectedOwnerBal.String(), ownerBalAfter.String())

    expectedUser1Bal := new(big.Int).Add(user1BalBefore, transferAmount)
    assert.Equal(t, expectedUser1Bal.String(), user1BalAfter.String())
}

func TestTokenTransferInsufficient(t *testing.T) {
    env := SetupTest(t)
    defer env.Backend.Close()

    // Deploy
    initialSupply := big.NewInt(1000)
    _, _, contract, err := token.DeployToken(env.Owner, env.Backend, initialSupply)
    require.NoError(t, err)
    env.Commit()

    // Try to transfer more than balance
    tooMuch := big.NewInt(10000)
    _, err = contract.Transfer(env.Owner, env.User1Addr, tooMuch)

    // Should fail
    require.Error(t, err)
    assert.Contains(t, err.Error(), "insufficient balance")
}

func TestTokenApproveAndTransferFrom(t *testing.T) {
    env := SetupTest(t)
    defer env.Backend.Close()

    // Deploy
    initialSupply := big.NewInt(1000000)
    _, _, contract, err := token.DeployToken(env.Owner, env.Backend, initialSupply)
    require.NoError(t, err)
    env.Commit()

    // Owner approves User1 to spend tokens
    approveAmount := big.NewInt(5000)
    tx, err := contract.Approve(env.Owner, env.User1Addr, approveAmount)
    require.NoError(t, err)
    env.Commit()

    // Verify approval
    receipt, err := env.Backend.TransactionReceipt(context.Background(), tx.Hash())
    require.NoError(t, err)
    assert.Equal(t, uint64(1), receipt.Status)

    // Check allowance
    allowance, err := contract.Allowance(&bind.CallOpts{}, env.OwnerAddr, env.User1Addr)
    require.NoError(t, err)
    assert.Equal(t, approveAmount.String(), allowance.String())

    // User1 transfers from Owner to User2
    transferAmount := big.NewInt(1000)
    tx, err = contract.TransferFrom(env.User1, env.OwnerAddr, env.User2Addr, transferAmount)
    require.NoError(t, err)
    env.Commit()

    // Verify transfer
    receipt, err = env.Backend.TransactionReceipt(context.Background(), tx.Hash())
    require.NoError(t, err)
    assert.Equal(t, uint64(1), receipt.Status)

    // Verify balances
    user2Bal, err := contract.BalanceOf(&bind.CallOpts{}, env.User2Addr)
    require.NoError(t, err)
    assert.Equal(t, transferAmount.String(), user2Bal.String())

    // Verify allowance decreased
    newAllowance, err := contract.Allowance(&bind.CallOpts{}, env.OwnerAddr, env.User1Addr)
    require.NoError(t, err)
    expectedAllowance := new(big.Int).Sub(approveAmount, transferAmount)
    assert.Equal(t, expectedAllowance.String(), newAllowance.String())
}

func TestTokenEvents(t *testing.T) {
    env := SetupTest(t)
    defer env.Backend.Close()

    // Deploy
    initialSupply := big.NewInt(1000000)
    _, _, contract, err := token.DeployToken(env.Owner, env.Backend, initialSupply)
    require.NoError(t, err)
    env.Commit()

    // Transfer
    transferAmount := big.NewInt(1000)
    tx, err := contract.Transfer(env.Owner, env.User1Addr, transferAmount)
    require.NoError(t, err)
    env.Commit()

    // Get receipt and check logs
    receipt, err := env.Backend.TransactionReceipt(context.Background(), tx.Hash())
    require.NoError(t, err)

    // Should have Transfer event
    assert.NotEmpty(t, receipt.Logs)

    // Filter Transfer events
    startBlock := uint64(0)
    iter, err := contract.FilterTransfer(
        &bind.FilterOpts{Start: startBlock},
        []common.Address{env.OwnerAddr},
        []common.Address{env.User1Addr},
    )
    require.NoError(t, err)
    defer iter.Close()

    // Verify event data
    found := false
    for iter.Next() {
        event := iter.Event
        assert.Equal(t, env.OwnerAddr, event.From)
        assert.Equal(t, env.User1Addr, event.To)
        assert.Equal(t, transferAmount.String(), event.Value.String())
        found = true
    }

    assert.True(t, found, "Transfer event not found")
}

func TestTimeManipulation(t *testing.T) {
    env := SetupTest(t)
    defer env.Backend.Close()

    // Get current block time
    block, err := env.Backend.BlockByNumber(context.Background(), nil)
    require.NoError(t, err)
    initialTime := block.Time()

    // Advance time by 1 hour
    err = env.Backend.AdjustTime(3600 * time.Second)
    require.NoError(t, err)
    env.Commit()

    // Verify time advanced
    block, err = env.Backend.BlockByNumber(context.Background(), nil)
    require.NoError(t, err)
    newTime := block.Time()

    assert.Greater(t, newTime, initialTime+3600)
}
```

### 6.3 Table-Driven Tests

Table-driven tests are the idiomatic Go pattern for verifying a function across many input/output pairs within a single test function. This approach reduces boilerplate, produces clear failure output identifying the specific failing case, and makes adding new scenarios trivial.

```go
func TestTokenTransferVariations(t *testing.T) {
    tests := []struct {
        name          string
        initialSupply *big.Int
        transferAmt   *big.Int
        expectError   bool
        errorContains string
    }{
        {
            name:          "successful transfer",
            initialSupply: big.NewInt(1000),
            transferAmt:   big.NewInt(100),
            expectError:   false,
        },
        {
            name:          "transfer all",
            initialSupply: big.NewInt(1000),
            transferAmt:   big.NewInt(1000),
            expectError:   false,
        },
        {
            name:          "insufficient balance",
            initialSupply: big.NewInt(100),
            transferAmt:   big.NewInt(1000),
            expectError:   true,
            errorContains: "insufficient",
        },
        {
            name:          "zero transfer",
            initialSupply: big.NewInt(1000),
            transferAmt:   big.NewInt(0),
            expectError:   false,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            env := SetupTest(t)
            defer env.Backend.Close()

            // Deploy
            _, _, contract, err := token.DeployToken(env.Owner, env.Backend, tt.initialSupply)
            require.NoError(t, err)
            env.Commit()

            // Transfer
            _, err = contract.Transfer(env.Owner, env.User1Addr, tt.transferAmt)

            if tt.expectError {
                require.Error(t, err)
                if tt.errorContains != "" {
                    assert.Contains(t, err.Error(), tt.errorContains)
                }
            } else {
                require.NoError(t, err)
                env.Commit()

                // Verify balance
                balance, err := contract.BalanceOf(&bind.CallOpts{}, env.User1Addr)
                require.NoError(t, err)
                assert.Equal(t, tt.transferAmt.String(), balance.String())
            }
        })
    }
}
```

---

### Junior → FAANG: Testing Smart Contract Interactions in Go

Testing smart contract interactions in Go requires a different approach from testing regular API clients: you need a real (or simulated) EVM execution environment, not just a mock that returns predefined responses. Mocking an Ethereum RPC client that returns correct responses for simple reads is feasible, but testing the full interaction lifecycle (deploying a contract, calling functions, and verifying state changes) requires an actual EVM.

The `backends.SimulatedBackend` from the go-ethereum package provides an in-memory Ethereum simulation that is perfect for unit tests of contract interactions. It runs a real EVM, supports deploying contracts, and allows you to manually advance blocks (using `Commit()`). The limitation is that it does not replicate the exact behavior of a mainnet node (no mempool, no gas estimation based on real market conditions, no p2p network behavior), but for testing correctness of ABI encoding, event decoding, and transaction construction, it is the right tool.

A worked test pattern: deploy your contract to the simulated backend, perform the operations under test, call `Commit()` to include them in a block, and then read the resulting state or events to verify correctness. This test runs in milliseconds (no network round trips) and is completely deterministic (same test inputs always produce the same outputs). Write one test per significant contract interaction path.

Interview entry point: explain why testing against a simulated backend is not a complete substitute for mainnet fork testing. The simulated backend does not replicate the exact state of deployed contracts (their storage, token balances, or user approvals) that your production code will interact with. Mainnet fork testing (using Anvil or Hardhat to fork mainnet at a specific block) allows you to test against the actual deployed state of Uniswap, Aave, or any other contract your code integrates with, catching integration issues that simulated tests miss.

First-job habit: for every smart contract interaction your Go code performs, write at least one test that exercises the happy path on a simulated backend and one test that exercises the most likely error case (contract revert, insufficient balance, or incorrect allowance). This minimum test coverage is not comprehensive but it catches the most common mistakes before they reach code review.

### Senior @ FAANG: Contract Testing Strategies for Production Integration Confidence

At staff level, the testing strategy for smart contract interactions is layered: unit tests using the simulated backend, integration tests using a mainnet fork, and smoke tests against the actual target network (testnet or mainnet). Each layer has different costs (execution speed, setup complexity, cost of running against real networks) and different coverage properties. Defining which tests live at each layer is a team standard that staff engineers establish.

Mainnet fork testing is the highest-fidelity approach for integration testing. Anvil (from Foundry) and Hardhat's hardhat-network both support forking mainnet at a specific block number. Go tests can use `ethclient` to connect to the forked network, deploy test contracts, interact with real deployed contracts (Uniswap, Aave, Chainlink oracles), and verify outcomes. This approach catches issues like changed contract addresses, updated function signatures in upgraded contracts, and unexpected state in the live environment that simulated tests cannot replicate.

Property-based testing for smart contract interactions is a valuable but underused technique. Instead of writing tests with specific input values, property-based testing generates random inputs within defined constraints and verifies invariants. For example: "for any amount between 1 wei and 10 ETH, the token balance after a successful transfer should increase by exactly that amount." Go's `testing/quick` package or `pgregory.net/rapid` can be used for this purpose. Property-based tests are particularly effective at finding edge cases in fee calculations and rounding behavior.

Negative testing coverage is critical for contract interaction code. For every require() or revert in the contract's code that your integration triggers, there should be a test that verifies the correct error is returned. This requires either reading the contract source to understand the revert conditions or using `eth_call` with malformed inputs to observe the revert reasons. Staff engineers enforce negative test coverage in code review and reject integration code that only tests happy paths.

Continuous integration for contract interaction tests requires careful infrastructure management. Tests that use the simulated backend run without external dependencies and are always appropriate for CI. Tests that use mainnet fork require an archive node (either self-hosted or a provider with archive access like Alchemy or Infura), which has cost implications. Organizing tests to separate simulated and fork-dependent tests using Go build tags allows CI to run the simulated tests on every commit and the fork-dependent tests on a schedule or pre-release.

Bar-raiser signals: designing a fuzzing harness for smart contract integration code (using Go 1.18+ fuzzing with `testing.F`) that generates random transaction parameters and verifies that the application correctly handles all contract revert reasons without panicking or entering an inconsistent state, or explaining how `eth_call` with a `StateOverride` parameter can be used to test contract interactions under specific state conditions without needing to set up the state through a sequence of transactions. These advanced testing techniques reveal a sophisticated understanding of the testing problem space.

---
