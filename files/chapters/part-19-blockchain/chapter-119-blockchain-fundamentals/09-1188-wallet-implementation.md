## 119.8 Wallet Implementation

Let's build a production-quality wallet that manages keys, creates transactions, and signs them.

```go
// wallets.go
package blockchain

import (
	"bytes"
	"crypto/elliptic"
	"encoding/gob"
	"fmt"
	"os"
)

const walletFile = "wallets_%s.dat"

// Wallets stores a collection of wallets
type Wallets struct {
	Wallets map[string]*Wallet
}

// NewWallets creates wallets collection
func NewWallets(nodeID string) (*Wallets, error) {
	wallets := Wallets{}
	wallets.Wallets = make(map[string]*Wallet)

	err := wallets.LoadFromFile(nodeID)

	return &wallets, err
}

// CreateWallet creates and adds a new wallet
func (ws *Wallets) CreateWallet() string {
	wallet, _ := NewWallet()
	address := wallet.GetAddress()

	ws.Wallets[address] = wallet

	return address
}

// GetAddresses returns all wallet addresses
func (ws *Wallets) GetAddresses() []string {
	var addresses []string

	for address := range ws.Wallets {
		addresses = append(addresses, address)
	}

	return addresses
}

// GetWallet returns a wallet by address
func (ws *Wallets) GetWallet(address string) *Wallet {
	return ws.Wallets[address]
}

// LoadFromFile loads wallets from file
func (ws *Wallets) LoadFromFile(nodeID string) error {
	walletFile := fmt.Sprintf(walletFile, nodeID)

	if _, err := os.Stat(walletFile); os.IsNotExist(err) {
		return err
	}

	fileContent, err := os.ReadFile(walletFile)
	if err != nil {
		return err
	}

	var wallets Wallets
	gob.Register(elliptic.P256())
	decoder := gob.NewDecoder(bytes.NewReader(fileContent))
	err = decoder.Decode(&wallets)
	if err != nil {
		return err
	}

	ws.Wallets = wallets.Wallets

	return nil
}

// SaveToFile saves wallets to file
func (ws *Wallets) SaveToFile(nodeID string) error {
	var content bytes.Buffer
	walletFile := fmt.Sprintf(walletFile, nodeID)

	gob.Register(elliptic.P256())

	encoder := gob.NewEncoder(&content)
	err := encoder.Encode(ws)
	if err != nil {
		return err
	}

	err = os.WriteFile(walletFile, content.Bytes(), 0644)
	if err != nil {
		return err
	}

	return nil
}
```

### Complete Wallet CLI

The wallet CLI dispatches subcommands (`create`, `list`, `balance`, `send`) to methods on `WalletCLI`, keeping each command's logic isolated and testable independently. Flags are parsed per subcommand rather than globally, preventing flag collisions and making the help text for each operation self-contained.

```go
// cli_wallet.go
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

// WalletCLI handles wallet commands
type WalletCLI struct {
	wallets *Wallets
}

// Run executes wallet CLI
func (cli *WalletCLI) Run() {
	cli.validateArgs()

	nodeID := os.Getenv("NODE_ID")
	if nodeID == "" {
		nodeID = "3000"
	}

	wallets, err := NewWallets(nodeID)
	if err != nil {
		log.Panic(err)
	}
	cli.wallets = wallets

	createWalletCmd := flag.NewFlagSet("createwallet", flag.ExitOnError)
	listAddressesCmd := flag.NewFlagSet("listaddresses", flag.ExitOnError)
	getBalanceCmd := flag.NewFlagSet("getbalance", flag.ExitOnError)
	sendCmd := flag.NewFlagSet("send", flag.ExitOnError)

	getBalanceAddress := getBalanceCmd.String("address", "", "Address to get balance for")
	sendFrom := sendCmd.String("from", "", "Source wallet address")
	sendTo := sendCmd.String("to", "", "Destination wallet address")
	sendAmount := sendCmd.Int("amount", 0, "Amount to send")

	switch os.Args[1] {
	case "createwallet":
		err := createWalletCmd.Parse(os.Args[2:])
		if err != nil {
			log.Panic(err)
		}
	case "listaddresses":
		err := listAddressesCmd.Parse(os.Args[2:])
		if err != nil {
			log.Panic(err)
		}
	case "getbalance":
		err := getBalanceCmd.Parse(os.Args[2:])
		if err != nil {
			log.Panic(err)
		}
	case "send":
		err := sendCmd.Parse(os.Args[2:])
		if err != nil {
			log.Panic(err)
		}
	default:
		cli.printUsage()
		os.Exit(1)
	}

	if createWalletCmd.Parsed() {
		cli.createWallet(nodeID)
	}

	if listAddressesCmd.Parsed() {
		cli.listAddresses()
	}

	if getBalanceCmd.Parsed() {
		if *getBalanceAddress == "" {
			getBalanceCmd.Usage()
			os.Exit(1)
		}
		cli.getBalance(*getBalanceAddress)
	}

	if sendCmd.Parsed() {
		if *sendFrom == "" || *sendTo == "" || *sendAmount <= 0 {
			sendCmd.Usage()
			os.Exit(1)
		}
		cli.send(*sendFrom, *sendTo, *sendAmount, nodeID)
	}
}

func (cli *WalletCLI) createWallet(nodeID string) {
	address := cli.wallets.CreateWallet()
	cli.wallets.SaveToFile(nodeID)

	fmt.Printf("New address: %s\n", address)
}

func (cli *WalletCLI) listAddresses() {
	addresses := cli.wallets.GetAddresses()

	for _, address := range addresses {
		fmt.Println(address)
	}
}

func (cli *WalletCLI) getBalance(address string) {
	// Integration with blockchain to get balance
	fmt.Printf("Balance of '%s': %d\n", address, 0)
}

func (cli *WalletCLI) send(from, to string, amount int, nodeID string) {
	// Integration with blockchain to send transaction
	fmt.Printf("Sent %d from %s to %s\n", amount, from, to)
}

func (cli *WalletCLI) validateArgs() {
	if len(os.Args) < 2 {
		cli.printUsage()
		os.Exit(1)
	}
}

func (cli *WalletCLI) printUsage() {
	fmt.Println("Usage:")
	fmt.Println("  createwallet - Create a new wallet")
	fmt.Println("  listaddresses - List all addresses")
	fmt.Println("  getbalance -address ADDRESS - Get balance of address")
	fmt.Println("  send -from FROM -to TO -amount AMOUNT - Send amount")
}
```

---

### Junior → FAANG: Wallet Implementation as Key Management 101

Wallet implementation is the practical intersection of elliptic curve cryptography and user-facing software design. The most important prerequisite gap for juniors is understanding that a "wallet" does not hold funds: it holds private keys, and the funds exist on-chain associated with the address derived from those keys. This distinction changes every design decision about storage, backup, and recovery.

The BIP-32 hierarchical deterministic wallet standard is the baseline you need to understand before implementing any production wallet component in Go. BIP-32 derives a tree of key pairs from a single root seed using HMAC-SHA512. BIP-44 specifies the derivation path structure (`m/44'/coin_type'/account'/change/index`). The `github.com/tyler-smith/go-bip32` and `github.com/tyler-smith/go-bip39` packages provide Go implementations, but you should be able to explain what each derivation step does before you use them.

A worked exercise: implement a function that takes a BIP-39 mnemonic, derives the HD wallet seed, generates the first five Ethereum addresses at the standard derivation path (`m/44'/60'/0'/0/0` through index 4), and verifies that each address matches what MetaMask generates for the same mnemonic. This verification exercise will catch any serialization or curve parameter errors immediately.

Interview entry point: explain the difference between a hot wallet (private key accessible to online software, suitable for operational use with limited funds), a warm wallet (private key accessible on an air-gapped machine, requires manual approval for each transaction), and a cold wallet (private key on hardware, requires physical interaction). Be able to recommend the right tier for different use cases: exchange hot wallet, treasury management, validator fee recipient.

### Senior @ FAANG: Wallet Architecture and Custody Risk Management

At staff level, wallet implementation is a custody architecture problem, and custody is the highest-stakes engineering concern in any system that holds or manages digital assets. The regulatory definition of custody (as interpreted by the SEC and other regulators) has direct implications for which wallet architectures are permissible for certain business models. Staff engineers at regulated entities must understand these constraints before designing any system that controls private keys on behalf of users.

The three dominant custody architecture patterns for institutional-scale blockchain systems are: (1) self-custody with HSM-backed signing, where the private key never leaves an HSM and all signing operations are performed inside the hardware boundary, (2) MPC-based threshold signing, where the private key is never reconstructed in full and signing requires cooperation between N of M parties, and (3) multisig smart contracts (Gnosis Safe and equivalents), where control is enforced on-chain through a threshold of authorized signers. ADRs for custody systems must compare all three against the threat model, regulatory environment, and operational constraints of the organization.

HSM integration in Go requires working with PKCS11 interfaces or cloud KMS APIs (AWS CloudHSM, Google Cloud HSM, Azure Dedicated HSM). The signing operation for an Ethereum transaction using an HSM-backed key is: serialize the transaction in RLP format, compute the Keccak-256 hash of the serialized transaction, submit the hash to the HSM for signing, and encode the signature (r, s, v) into the transaction. The HSM never sees the serialized transaction, only the hash, which means the application layer must be trusted for correct serialization. Staff engineers design audit controls around this trust boundary.

MPC signing protocols (specifically GG18, GG20, and CGGMP21) have been the subject of several published implementation vulnerabilities since 2022. The Lindell17 two-party protocol had an implementation flaw discovered in the Curv library that could leak private key shares under specific error conditions. Staff engineers evaluating MPC libraries must check whether their library has been independently audited against these known vulnerability classes and must have a plan for key rotation if a vulnerability is discovered in their library after deployment.

Key rotation in wallet systems that manage on-chain addresses is architecturally difficult because the address itself is derived from the public key. Rotating the key means migrating funds to a new address, which is an on-chain operation that must be carefully sequenced (new address funded and verified before old address drained). At scale, key rotation across thousands of addresses is a complex orchestration problem. Staff engineers design key rotation systems with rollback capability, staged execution, and independent verification of each address migration.

Bar-raiser signals: explaining the Shamir Secret Sharing scheme and its security assumptions (information-theoretic security for threshold less than k, but no protection against an adversary who has k or more shares), or designing a key ceremony process for generating a new institutional multisig key set that provides evidence to auditors that no single participant learned the full key. These topics go well beyond API usage and test whether a candidate can reason about the trust assumptions of cryptographic protocols.

Compliance dimensions of wallet implementation include: transaction signing policy enforcement (does the wallet check the destination address against a sanctions list before signing?), transaction amount limits enforced at the signing layer (not just the application layer), and audit logging of all signing operations with enough context to reconstruct why each transaction was authorized. These controls are required for SOC 2 Type II compliance at any company that handles digital assets as a financial business.

---
