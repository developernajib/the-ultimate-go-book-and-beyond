## 123.5 IPFS Integration

IPFS (InterPlanetary File System) provides decentralized storage for Web3 applications.

### IPFS Client Implementation

The IPFS client wraps `go-ipfs-api` to add, pin, and retrieve content, returning the CID that serves as the permanent content address, the same string that gets stored in a smart contract's `tokenURI`. Pinning ensures the content is retained by the node and not garbage-collected. Without pinning, content added to IPFS is only temporarily cached and may become unavailable.

```go
// pkg/web3/storage/ipfs.go
package storage

import (
    "bytes"
    "context"
    "fmt"
    "io"

    ipfs "github.com/ipfs/go-ipfs-api"
)

// IPFSClient manages IPFS operations
type IPFSClient struct {
    shell   *ipfs.Shell
    gateway string
}

// NewIPFSClient creates a new IPFS client
func NewIPFSClient(endpoint, gateway string) *IPFSClient {
    return &IPFSClient{
        shell:   ipfs.NewShell(endpoint),
        gateway: gateway,
    }
}

// Add uploads data to IPFS
func (c *IPFSClient) Add(ctx context.Context, data []byte) (string, error) {
    hash, err := c.shell.Add(bytes.NewReader(data))
    if err != nil {
        return "", fmt.Errorf("failed to add to IPFS: %w", err)
    }
    return hash, nil
}

// AddFile uploads a file to IPFS
func (c *IPFSClient) AddFile(ctx context.Context, reader io.Reader) (string, error) {
    hash, err := c.shell.Add(reader)
    if err != nil {
        return "", fmt.Errorf("failed to add file to IPFS: %w", err)
    }
    return hash, nil
}

// Get retrieves data from IPFS
func (c *IPFSClient) Get(ctx context.Context, hash string) ([]byte, error) {
    reader, err := c.shell.Cat(hash)
    if err != nil {
        return nil, fmt.Errorf("failed to get from IPFS: %w", err)
    }
    defer reader.Close()

    data, err := io.ReadAll(reader)
    if err != nil {
        return nil, fmt.Errorf("failed to read IPFS data: %w", err)
    }

    return data, nil
}

// Pin pins content to prevent garbage collection
func (c *IPFSClient) Pin(ctx context.Context, hash string) error {
    if err := c.shell.Pin(hash); err != nil {
        return fmt.Errorf("failed to pin: %w", err)
    }
    return nil
}

// Unpin removes a pin
func (c *IPFSClient) Unpin(ctx context.Context, hash string) error {
    if err := c.shell.Unpin(hash); err != nil {
        return fmt.Errorf("failed to unpin: %w", err)
    }
    return nil
}

// GetURL returns a public gateway URL for a hash
func (c *IPFSClient) GetURL(hash string) string {
    return fmt.Sprintf("%s/ipfs/%s", c.gateway, hash)
}
```

### NFT Metadata Storage

NFT metadata lives off-chain by necessity, on-chain bytes are too expensive for images and JSON, so the token stores a content-addressed IPFS URI whose hash guarantees the metadata cannot be silently swapped.

```go
// pkg/web3/storage/nft.go
package storage

import (
    "context"
    "encoding/json"
    "fmt"
)

// NFTMetadata represents NFT metadata
type NFTMetadata struct {
    Name        string            `json:"name"`
    Description string            `json:"description"`
    Image       string            `json:"image"`
    Attributes  []NFTAttribute    `json:"attributes"`
    ExternalURL string            `json:"external_url,omitempty"`
    Properties  map[string]string `json:"properties,omitempty"`
}

// NFTAttribute represents an NFT attribute
type NFTAttribute struct {
    TraitType string      `json:"trait_type"`
    Value     any `json:"value"`
}

// UploadNFTMetadata uploads NFT metadata to IPFS
func (c *IPFSClient) UploadNFTMetadata(
    ctx context.Context,
    metadata NFTMetadata,
) (string, error) {
    // Marshal metadata to JSON
    data, err := json.Marshal(metadata)
    if err != nil {
        return "", fmt.Errorf("failed to marshal metadata: %w", err)
    }

    // Upload to IPFS
    hash, err := c.Add(ctx, data)
    if err != nil {
        return "", err
    }

    // Pin the content
    if err := c.Pin(ctx, hash); err != nil {
        return "", err
    }

    return hash, nil
}

// GetNFTMetadata retrieves NFT metadata from IPFS
func (c *IPFSClient) GetNFTMetadata(
    ctx context.Context,
    hash string,
) (*NFTMetadata, error) {
    data, err := c.Get(ctx, hash)
    if err != nil {
        return nil, err
    }

    var metadata NFTMetadata
    if err := json.Unmarshal(data, &metadata); err != nil {
        return nil, fmt.Errorf("failed to unmarshal metadata: %w", err)
    }

    return &metadata, nil
}
```

### IPFS with Pinata

Pinata is a popular pinning service for IPFS:

```go
// pkg/web3/storage/pinata.go
package storage

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "mime/multipart"
    "net/http"
)

// PinataClient manages Pinata pinning service
type PinataClient struct {
    apiKey    string
    apiSecret string
    gateway   string
    client    *http.Client
}

// NewPinataClient creates a new Pinata client
func NewPinataClient(apiKey, apiSecret string) *PinataClient {
    return &PinataClient{
        apiKey:    apiKey,
        apiSecret: apiSecret,
        gateway:   "https://gateway.pinata.cloud",
        client:    &http.Client{},
    }
}

// PinJSONResponse represents Pinata pin JSON response
type PinJSONResponse struct {
    IpfsHash  string `json:"IpfsHash"`
    PinSize   int64  `json:"PinSize"`
    Timestamp string `json:"Timestamp"`
}

// PinJSON pins JSON data to IPFS via Pinata
func (p *PinataClient) PinJSON(
    ctx context.Context,
    data any,
    name string,
) (*PinJSONResponse, error) {
    jsonData, err := json.Marshal(data)
    if err != nil {
        return nil, fmt.Errorf("failed to marshal data: %w", err)
    }

    reqBody := map[string]any{
        "pinataContent": json.RawMessage(jsonData),
        "pinataMetadata": map[string]string{
            "name": name,
        },
    }

    reqJSON, err := json.Marshal(reqBody)
    if err != nil {
        return nil, fmt.Errorf("failed to marshal request: %w", err)
    }

    req, err := http.NewRequestWithContext(
        ctx,
        "POST",
        "https://api.pinata.cloud/pinning/pinJSONToIPFS",
        bytes.NewReader(reqJSON),
    )
    if err != nil {
        return nil, err
    }

    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("pinata_api_key", p.apiKey)
    req.Header.Set("pinata_secret_api_key", p.apiSecret)

    resp, err := p.client.Do(req)
    if err != nil {
        return nil, fmt.Errorf("request failed: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("pinata error: %s", body)
    }

    var result PinJSONResponse
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("failed to decode response: %w", err)
    }

    return &result, nil
}

// PinFile pins a file to IPFS via Pinata
func (p *PinataClient) PinFile(
    ctx context.Context,
    reader io.Reader,
    filename string,
) (*PinJSONResponse, error) {
    var buf bytes.Buffer
    writer := multipart.NewWriter(&buf)

    part, err := writer.CreateFormFile("file", filename)
    if err != nil {
        return nil, err
    }

    if _, err := io.Copy(part, reader); err != nil {
        return nil, err
    }

    writer.Close()

    req, err := http.NewRequestWithContext(
        ctx,
        "POST",
        "https://api.pinata.cloud/pinning/pinFileToIPFS",
        &buf,
    )
    if err != nil {
        return nil, err
    }

    req.Header.Set("Content-Type", writer.FormDataContentType())
    req.Header.Set("pinata_api_key", p.apiKey)
    req.Header.Set("pinata_secret_api_key", p.apiSecret)

    resp, err := p.client.Do(req)
    if err != nil {
        return nil, fmt.Errorf("request failed: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("pinata error: %s", body)
    }

    var result PinJSONResponse
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("failed to decode response: %w", err)
    }

    return &result, nil
}
```

### Junior → FAANG: IPFS as the Decentralized Storage Layer for Web3

IPFS (InterPlanetary File System) is a content-addressed distributed storage system commonly used in Web3 for storing NFT metadata, DApp frontends, and any other off-chain data that needs decentralized storage. Understanding IPFS is important for any Go engineer working on NFT platforms, DApp hosting, or any system that stores arbitrary data in a decentralized manner.

The key concept in IPFS is content addressing: each piece of data is identified by its CID (Content Identifier), which is the hash of the content. Requesting a CID from IPFS retrieves the data and cryptographically verifies it matches the CID. This means you can trust the content if you trust the CID, regardless of which IPFS node serves it. The CID cannot be faked: any content that does not hash to the requested CID is rejected.

The Go IPFS client (`github.com/ipfs/go-ipfs-api` or the newer `github.com/ipfs/kubo/client/rpc`) connects to an IPFS daemon running locally or remotely. For read-only operations (fetching NFT metadata), using a public IPFS gateway (Cloudflare IPFS Gateway, Pinata's gateway, or IPFS's own public gateway) via HTTP is simpler than running your own node. For write operations (uploading and pinning content), you need either your own node or a pinning service (Pinata, Filebase, web3.storage).

Interview entry point: explain the IPFS pinning problem. By default, content you add to an IPFS node is cached temporarily and may be garbage-collected when the node's cache is full. Pinning prevents garbage collection for specific CIDs. If you are storing NFT metadata on IPFS, you must ensure the metadata is pinned on at least one node that will remain online indefinitely. Otherwise, the metadata may become unavailable, breaking the NFT's metadata display on marketplaces. Using a pinning service with a defined SLA is the production approach.

### Senior @ FAANG: IPFS Infrastructure for Production Web3 Applications

At staff level, IPFS infrastructure design for production Web3 applications requires addressing three concerns: content availability (how do you ensure content remains accessible?), performance (how do you minimize latency for content retrieval?), and cost (how do you manage the storage costs for potentially large amounts of content?).

Content availability requires a multi-layer pinning strategy. Content pinned only on a single service is vulnerable to that service going offline or changing its business model (several IPFS pinning services have shut down without warning). A robust strategy pins important content on at least three independent services and maintains a local archive copy on infrastructure you control. For NFT projects that have committed to maintaining metadata availability, a dedicated IPFS cluster running on cloud infrastructure with independent backups is the highest-reliability option.

Performance optimization for IPFS content retrieval typically requires using a CDN-backed gateway rather than the public IPFS gateways. Public gateways have variable latency depending on the routing and caching state of the content. A dedicated gateway (either self-hosted with a Nginx/Caddy layer in front of an IPFS node, or through Cloudflare's IPFS gateway with custom domain) allows CDN caching of frequently accessed content, reducing latency for popular NFT metadata from seconds to milliseconds.

Merkle DAG (Directed Acyclic Graph) structure of IPFS is important for applications that store complex data structures rather than flat files. A directory of files is represented as a Merkle DAG where the root CID references the directory node, which references the individual file nodes. Updating a single file in a large directory requires creating new nodes only for the changed file and the directory entries between it and the root, which is efficient for incremental updates. Staff engineers who design IPFS-based data structures benefit from understanding this DAG structure and designing data layouts that minimize the number of nodes that need to be updated for common modification patterns.

Regulatory considerations for IPFS content are evolving. IPFS content is censorship-resistant by design (anyone can pin and serve content), which creates challenges for applications that need to respond to DMCA takedowns or illegal content reports. Content-addressed storage means you cannot "delete" content from IPFS. You can only stop serving it and stop pinning it. If illegal content is uploaded using your application and pinned on your infrastructure, your legal obligations depend on your jurisdiction and the content type. Staff engineers at companies that provide IPFS-based storage should have legal guidance on their obligations and a defined content moderation and takedown procedure before launch.

Bar-raiser signals: designing a metadata freshness verification system for NFTs that periodically fetches each NFT's tokenURI, resolves the IPFS CID, verifies that the fetched content hashes to the CID, and alerts when content is unavailable or has changed (which should never happen for a properly content-addressed CID but can happen if the tokenURI points to a mutable URL rather than an IPFS CID), or explaining the difference between IPFS CIDv0 (base58-encoded multihash, used by older tooling) and CIDv1 (base32-encoded, self-describing, used by modern IPFS) and how to convert between them in Go. These details reveal genuine IPFS implementation experience.

---
