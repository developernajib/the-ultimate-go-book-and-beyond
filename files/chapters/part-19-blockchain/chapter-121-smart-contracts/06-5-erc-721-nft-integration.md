## 121.5 ERC-721 NFT Integration

ERC-721 defines non-fungible tokens (NFTs) - each token is unique.

### 5.1 ERC-721 Standard Interface

The ERC-721 interface assigns ownership at the individual token ID level rather than by balance, so `ownerOf(tokenId)` is the authoritative ownership check rather than any balance field. The `tokenURI` function returns a URL pointing to off-chain JSON metadata, typically stored on IPFS, that contains the NFT's image URL, attributes, and display name.

```solidity
// ERC-721 Standard (excerpt)
interface IERC721 {
    // Returns the number of tokens in owner's account
    function balanceOf(address owner) external view returns (uint256);

    // Returns the owner of the tokenId token
    function ownerOf(uint256 tokenId) external view returns (address);

    // Safely transfers tokenId from from to to
    function safeTransferFrom(address from, address to, uint256 tokenId) external;

    // Transfers tokenId from from to to
    function transferFrom(address from, address to, uint256 tokenId) external;

    // Gives permission to to to transfer tokenId
    function approve(address to, uint256 tokenId) external;

    // Returns the account approved for tokenId
    function getApproved(uint256 tokenId) external view returns (address);

    // Approve or remove operator as an operator for the caller
    function setApprovalForAll(address operator, bool approved) external;

    // Returns if operator is approved to manage all of owner's assets
    function isApprovedForAll(address owner, address operator) external view returns (bool);

    // Events
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
}

// ERC-721 Metadata (optional but common)
interface IERC721Metadata {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}
```

### 5.2 Complete ERC-721 Client

The ERC-721 Go client resolves `tokenURI` to off-chain JSON metadata by making an HTTP request, then deserializes the OpenSea-compatible metadata structure into a typed `NFTMetadata` struct. Caching the metadata response avoids repeated off-chain fetches on every display request, since the URI for a given token ID is immutable once minted.

```go
package erc721

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
    "math/big"
    "net/http"
    "time"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// Client wraps ERC-721 NFT interactions
type Client struct {
    contract *erc721.ERC721 // Generated binding
    client   *ethclient.Client
    address  common.Address
}

// NewClient creates an ERC-721 client
func NewClient(ctx context.Context, rpcURL string, contractAddr common.Address) (*Client, error) {
    client, err := ethclient.DialContext(ctx, rpcURL)
    if err != nil {
        return nil, fmt.Errorf("dial: %w", err)
    }

    contract, err := erc721.NewERC721(contractAddr, client)
    if err != nil {
        client.Close()
        return nil, fmt.Errorf("create binding: %w", err)
    }

    return &Client{
        contract: contract,
        client:   client,
        address:  contractAddr,
    }, nil
}

// EthClient returns the underlying ethclient instance
func (c *Client) EthClient() *ethclient.Client {
    return c.client
}

// Close closes the client
func (c *Client) Close() {
    if c.client != nil {
        c.client.Close()
    }
}

// CollectionInfo holds NFT collection metadata
type CollectionInfo struct {
    Name    string
    Symbol  string
    Address common.Address
}

// GetCollectionInfo retrieves collection metadata
func (c *Client) GetCollectionInfo(ctx context.Context) (*CollectionInfo, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    opts := &bind.CallOpts{Context: ctx}

    name, err := c.contract.Name(opts)
    if err != nil {
        return nil, fmt.Errorf("get name: %w", err)
    }

    symbol, err := c.contract.Symbol(opts)
    if err != nil {
        return nil, fmt.Errorf("get symbol: %w", err)
    }

    return &CollectionInfo{
        Name:    name,
        Symbol:  symbol,
        Address: c.address,
    }, nil
}

// OwnerOf returns the owner of a token
func (c *Client) OwnerOf(ctx context.Context, tokenID *big.Int) (common.Address, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    owner, err := c.contract.OwnerOf(&bind.CallOpts{Context: ctx}, tokenID)
    if err != nil {
        return common.Address{}, fmt.Errorf("owner of: %w", err)
    }

    return owner, nil
}

// BalanceOf returns the NFT balance of an address
func (c *Client) BalanceOf(ctx context.Context, address common.Address) (*big.Int, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    balance, err := c.contract.BalanceOf(&bind.CallOpts{Context: ctx}, address)
    if err != nil {
        return nil, fmt.Errorf("balance of: %w", err)
    }

    return balance, nil
}

// TokenURI returns the metadata URI for a token
func (c *Client) TokenURI(ctx context.Context, tokenID *big.Int) (string, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    uri, err := c.contract.TokenURI(&bind.CallOpts{Context: ctx}, tokenID)
    if err != nil {
        return "", fmt.Errorf("token uri: %w", err)
    }

    return uri, nil
}

// NFTMetadata represents the standard NFT metadata format
type NFTMetadata struct {
    Name        string      `json:"name"`
    Description string      `json:"description"`
    Image       string      `json:"image"`
    ExternalURL string      `json:"external_url,omitempty"`
    Attributes  []Attribute `json:"attributes,omitempty"`
}

// Attribute represents NFT attribute/trait
type Attribute struct {
    TraitType string      `json:"trait_type"`
    Value     any `json:"value"`
}

// GetMetadata fetches and parses NFT metadata
func (c *Client) GetMetadata(ctx context.Context, tokenID *big.Int) (*NFTMetadata, error) {
    // Get token URI
    uri, err := c.TokenURI(ctx, tokenID)
    if err != nil {
        return nil, err
    }

    // Handle IPFS URIs
    if len(uri) > 7 && uri[:7] == "ipfs://" {
        uri = "https://ipfs.io/ipfs/" + uri[7:]
    }

    // Fetch metadata
    req, err := http.NewRequestWithContext(ctx, "GET", uri, nil)
    if err != nil {
        return nil, fmt.Errorf("create request: %w", err)
    }

    client := &http.Client{Timeout: 30 * time.Second}
    resp, err := client.Do(req)
    if err != nil {
        return nil, fmt.Errorf("fetch metadata: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
    }

    // Parse JSON
    var metadata NFTMetadata
    if err := json.NewDecoder(resp.Body).Decode(&metadata); err != nil {
        return nil, fmt.Errorf("parse metadata: %w", err)
    }

    return &metadata, nil
}

// TransferFrom transfers an NFT
func (c *Client) TransferFrom(
    ctx context.Context,
    auth *bind.TransactOpts,
    from common.Address,
    to common.Address,
    tokenID *big.Int,
) (*types.Transaction, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    auth.Context = ctx

    tx, err := c.contract.TransferFrom(auth, from, to, tokenID)
    if err != nil {
        return nil, fmt.Errorf("transfer from: %w", err)
    }

    return tx, nil
}

// SafeTransferFrom safely transfers an NFT (calls onERC721Received on recipient)
func (c *Client) SafeTransferFrom(
    ctx context.Context,
    auth *bind.TransactOpts,
    from common.Address,
    to common.Address,
    tokenID *big.Int,
) (*types.Transaction, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    auth.Context = ctx

    tx, err := c.contract.SafeTransferFrom(auth, from, to, tokenID)
    if err != nil {
        return nil, fmt.Errorf("safe transfer from: %w", err)
    }

    return tx, nil
}

// Approve approves an address to transfer a specific token
func (c *Client) Approve(
    ctx context.Context,
    auth *bind.TransactOpts,
    approved common.Address,
    tokenID *big.Int,
) (*types.Transaction, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    auth.Context = ctx

    tx, err := c.contract.Approve(auth, approved, tokenID)
    if err != nil {
        return nil, fmt.Errorf("approve: %w", err)
    }

    return tx, nil
}

// SetApprovalForAll approves or revokes operator for all tokens
func (c *Client) SetApprovalForAll(
    ctx context.Context,
    auth *bind.TransactOpts,
    operator common.Address,
    approved bool,
) (*types.Transaction, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    auth.Context = ctx

    tx, err := c.contract.SetApprovalForAll(auth, operator, approved)
    if err != nil {
        return nil, fmt.Errorf("set approval for all: %w", err)
    }

    return tx, nil
}

// GetApproved returns the approved address for a token
func (c *Client) GetApproved(ctx context.Context, tokenID *big.Int) (common.Address, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    approved, err := c.contract.GetApproved(&bind.CallOpts{Context: ctx}, tokenID)
    if err != nil {
        return common.Address{}, fmt.Errorf("get approved: %w", err)
    }

    return approved, nil
}

// IsApprovedForAll returns if operator is approved for all of owner's tokens
func (c *Client) IsApprovedForAll(
    ctx context.Context,
    owner common.Address,
    operator common.Address,
) (bool, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    approved, err := c.contract.IsApprovedForAll(&bind.CallOpts{Context: ctx}, owner, operator)
    if err != nil {
        return false, fmt.Errorf("is approved for all: %w", err)
    }

    return approved, nil
}
```

### 5.3 NFT Marketplace Integration Example

The marketplace integration coordinates two on-chain transactions in sequence: first `setApprovalForAll` grants the marketplace contract permission to transfer any of the seller's tokens, then the listing call records the price on-chain so the marketplace can execute `transferFrom` atomically with the ETH payment. Missing the approval step causes every purchase attempt to revert, a common integration mistake that is only caught at transaction execution time.

```go
package marketplace

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"

    "myproject/erc721"
)

// Listing represents an NFT listing
type Listing struct {
    TokenID *big.Int
    Price   *big.Int
    Seller  common.Address
}

// Marketplace handles NFT trading
type Marketplace struct {
    nftClient *erc721.Client
    // marketplace contract, payment handling, etc.
}

// ListNFT lists an NFT for sale
func (m *Marketplace) ListNFT(
    ctx context.Context,
    auth *bind.TransactOpts,
    tokenID *big.Int,
    price *big.Int,
) error {
    // Step 1: Verify ownership
    owner, err := m.nftClient.OwnerOf(ctx, tokenID)
    if err != nil {
        return fmt.Errorf("verify ownership: %w", err)
    }

    if owner != auth.From {
        return fmt.Errorf("not token owner")
    }

    // Step 2: Approve marketplace to transfer NFT
    marketplaceAddr := common.HexToAddress("0x...") // Your marketplace contract

    tx, err := m.nftClient.Approve(ctx, auth, marketplaceAddr, tokenID)
    if err != nil {
        return fmt.Errorf("approve marketplace: %w", err)
    }

    // Wait for approval
    receipt, err := bind.WaitMined(ctx, m.nftClient.EthClient(), tx)
    if err != nil {
        return fmt.Errorf("wait approval: %w", err)
    }

    if receipt.Status != 1 {
        return fmt.Errorf("approval failed")
    }

    // Step 3: Create listing in marketplace contract
    // (This would call your marketplace contract's list function)
    fmt.Printf("NFT #%s listed for %s wei\n", tokenID.String(), price.String())

    return nil
}

// BuyNFT purchases a listed NFT
func (m *Marketplace) BuyNFT(
    ctx context.Context,
    auth *bind.TransactOpts,
    tokenID *big.Int,
    seller common.Address,
) error {
    // Step 1: Get listing details
    // (Fetch from marketplace contract)

    // Step 2: Verify seller still owns NFT
    owner, err := m.nftClient.OwnerOf(ctx, tokenID)
    if err != nil {
        return fmt.Errorf("verify ownership: %w", err)
    }

    if owner != seller {
        return fmt.Errorf("seller no longer owns NFT")
    }

    // Step 3: Call marketplace contract to execute purchase
    // This would:
    // - Transfer payment to seller
    // - Transfer NFT to buyer
    // - Emit Purchase event

    fmt.Printf("Purchased NFT #%s from %s\n", tokenID.String(), seller.Hex())

    return nil
}
```

---

### Junior → FAANG: ERC-721 NFT Integration Essentials

ERC-721 (Non-Fungible Token) defines the interface for unique digital assets on Ethereum. Unlike ERC-20 where all tokens are identical, each ERC-721 token has a unique `tokenId` that distinguishes it from every other token in the collection. Understanding this distinction drives every design decision in NFT integration: you cannot batch transfer 100 NFTs the same way you can batch transfer ERC-20 tokens, because each NFT has its own state.

The key functions in ERC-721 are: `ownerOf(tokenId)` (returns the current owner), `transferFrom(from, to, tokenId)` (transfers a specific token), `safeTransferFrom` (transfers with a callback to verify the recipient can handle NFTs), `approve(to, tokenId)` (approves a single transfer), and `setApprovalForAll(operator, approved)` (approves an operator for all tokens owned by the caller). The `safeTransferFrom` function is the safe default for NFT transfers when the recipient might be a contract, as it will revert if the recipient contract does not implement `ERC721Receiver`.

Token metadata is the most visible aspect of an NFT from a user perspective. The `tokenURI(tokenId)` function returns a URI (typically an IPFS URI like `ipfs://...`) pointing to a JSON metadata file. The metadata file follows the OpenSea metadata standard and includes fields like `name`, `description`, `image`, and `attributes`. Go integration code that works with NFT metadata must handle IPFS resolution (using an IPFS gateway), JSON parsing, and the possibility that the metadata URI returns a 404 or malformed JSON.

Interview entry point: explain the difference between `transferFrom` and `safeTransferFrom` in ERC-721. `transferFrom` does no check on the recipient and can permanently lock an NFT if sent to a contract that cannot handle ERC-721 tokens. `safeTransferFrom` calls `onERC721Received` on the recipient contract and reverts if the call fails or returns an unexpected value. Production code that transfers NFTs to contract addresses should always use `safeTransferFrom` unless the recipient is a known EOA.

### Senior @ FAANG: NFT Integration at Production Scale and Protocol Complexity

At staff level, NFT integration spans ERC-721 and the closely related ERC-1155 (multi-token standard, which supports both fungible and non-fungible tokens in a single contract). Understanding when to use each standard (ERC-721 for unique assets with metadata, ERC-1155 for game items that may have multiple copies, or for gas-efficient batch operations) is a design decision that affects the entire integration architecture.

NFT royalty enforcement is an evolving area with significant business implications. ERC-2981 provides a standard royalty information interface that marketplaces can query to determine the royalty amount for a sale. However, enforcement is voluntary at the marketplace level: on-chain royalty enforcement requires more complex designs (transfer hooks, operator allowlists) that limit who can transfer the token. The business decision about whether to use on-chain royalty enforcement (restricts secondary market liquidity) or royalty information without enforcement (maximizes liquidity but relies on marketplace compliance) is a product-level decision that staff engineers must contextualize technically.

NFT collection management at scale (for a company that issues or manages large NFT collections) requires infrastructure that tracks ownership across the entire token ID space efficiently. On-chain ownership queries for a collection of 100,000 NFTs require 100,000 individual `ownerOf` calls if done naively. Production systems use indexed event logs (`Transfer` events) to maintain an off-chain ownership database that can be queried without RPC calls. This is the foundation of any NFT marketplace or collection management platform.

The provenance challenge for NFTs (verifying that an NFT was created by a specific artist or entity) is a trust and verification problem that cannot be fully solved on-chain. Etherscan verification of the contract source confirms the contract logic, but does not confirm the identity of the deployer. Staff engineers designing NFT systems that make identity claims must combine on-chain contract verification with off-chain identity attestation systems (DNS TXT records, ENS name ownership, signed statements from trusted authorities).

Soulbound tokens (ERC-5192, non-transferable NFTs) are a recent standard for credentials, certifications, and identity-linked tokens. They modify the ERC-721 interface by reverting on all transfer attempts, making the token permanently bound to the initial recipient's address. Integration with soulbound tokens requires understanding that `transferFrom` will always revert, and that ownership verification (for access control purposes) is the only useful operation.

Bar-raiser signals: designing a provably fair NFT reveal system (where the random assignment of attributes to tokenIds is verifiable by anyone after the reveal), using Chainlink VRF or commit-reveal schemes, or explaining why batch minting using ERC-721A (Azuki's optimized ERC-721 implementation) reduces gas costs for sequential minting by deferring ownership initialization. These topics reveal deep familiarity with the NFT ecosystem's technical evolution.

---
