## 119.6 P2P Networking Basics

Blockchain nodes communicate via peer-to-peer networks. Let's build a simple P2P layer.

```go
// network.go
package blockchain

import (
	"bytes"
	"encoding/gob"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
)

const (
	protocol      = "tcp"
	nodeVersion   = 1
	commandLength = 12
)

var (
	nodeAddress     string
	knownNodes      = []string{"localhost:3000"} // Bootstrap nodes
	blocksInTransit = [][]byte{}
	mu              sync.RWMutex
)

// Message types
type (
	Version struct {
		Version    int
		BestHeight int
		AddrFrom   string
	}

	GetBlocks struct {
		AddrFrom string
	}

	Inv struct {
		AddrFrom string
		Type     string // "block" or "tx"
		Items    [][]byte
	}

	GetData struct {
		AddrFrom string
		Type     string
		ID       []byte
	}

	BlockMsg struct {
		AddrFrom string
		Block    []byte
	}

	Tx struct {
		AddrFrom    string
		Transaction []byte
	}
)

// StartServer starts a blockchain node
func StartServer(nodeID, minerAddress string) {
	nodeAddress = fmt.Sprintf("localhost:%s", nodeID)

	ln, err := net.Listen(protocol, nodeAddress)
	if err != nil {
		log.Panic(err)
	}
	defer ln.Close()

	log.Printf("Node %s listening on %s", nodeID, nodeAddress)

	// Send version to known nodes
	if nodeAddress != knownNodes[0] {
		sendVersion(knownNodes[0])
	}

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Println(err)
			continue
		}

		go handleConnection(conn, minerAddress)
	}
}

// handleConnection handles incoming connections
func handleConnection(conn net.Conn, minerAddress string) {
	defer conn.Close()

	request, err := io.ReadAll(conn)
	if err != nil {
		log.Println(err)
		return
	}

	command := bytesToCommand(request[:commandLength])
	log.Printf("Received %s command", command)

	switch command {
	case "version":
		handleVersion(request)
	case "getblocks":
		handleGetBlocks(request)
	case "inv":
		handleInv(request)
	case "getdata":
		handleGetData(request)
	case "block":
		handleBlock(request, minerAddress)
	case "tx":
		handleTx(request)
	default:
		log.Printf("Unknown command: %s", command)
	}
}

// sendVersion sends version to peer
func sendVersion(addr string) {
	// Implementation would get blockchain height and send
	log.Printf("Sending version to %s", addr)
}

// handleVersion handles version message
func handleVersion(request []byte) {
	var payload Version
	_ = payload
	_ = request
	// Decode and process version
	log.Printf("Handling version")
}

// sendGetBlocks requests blocks from peer
func sendGetBlocks(addr string) {
	payload := GetBlocks{AddrFrom: nodeAddress}
	data := gobEncode(payload)
	request := append(commandToBytes("getblocks"), data...)

	sendData(addr, request)
}

// handleGetBlocks handles block request
func handleGetBlocks(request []byte) {
	_ = request
	// Get blockchain and send inventory
	log.Printf("Handling getblocks")
}

// sendInv sends inventory to peer
func sendInv(addr, kind string, items [][]byte) {
	inventory := Inv{
		AddrFrom: nodeAddress,
		Type:     kind,
		Items:    items,
	}
	data := gobEncode(inventory)
	request := append(commandToBytes("inv"), data...)

	sendData(addr, request)
}

// handleInv handles inventory message
func handleInv(request []byte) {
	var payload Inv
	_ = request
	// Decode inventory and request missing items
	log.Printf("Handling inventory: %d %s", len(payload.Items), payload.Type)
}

// sendGetData requests specific data
func sendGetData(addr, kind string, id []byte) {
	payload := GetData{
		AddrFrom: nodeAddress,
		Type:     kind,
		ID:       id,
	}
	data := gobEncode(payload)
	request := append(commandToBytes("getdata"), data...)

	sendData(addr, request)
}

// handleGetData handles data request
func handleGetData(request []byte) {
	_ = request
	// Send requested block or transaction
	log.Printf("Handling getdata")
}

// handleBlock handles received block
func handleBlock(request []byte, minerAddress string) {
	var payload BlockMsg
	_ = payload
	_ = minerAddress
	_ = request
	// Add block to blockchain
	log.Printf("Received new block")
}

// handleTx handles received transaction
func handleTx(request []byte) {
	_ = request
	// Add transaction to mempool
	log.Printf("Received new transaction")
}

// sendData sends data to address
func sendData(addr string, data []byte) {
	conn, err := net.Dial(protocol, addr)
	if err != nil {
		log.Printf("%s is not available", addr)

		mu.Lock()
		// Remove from known nodes
		var updatedNodes []string
		for _, node := range knownNodes {
			if node != addr {
				updatedNodes = append(updatedNodes, node)
			}
		}
		knownNodes = updatedNodes
		mu.Unlock()

		return
	}
	defer conn.Close()

	_, err = io.Copy(conn, bytes.NewReader(data))
	if err != nil {
		log.Panic(err)
	}
}

// commandToBytes converts command to fixed-length bytes
func commandToBytes(command string) []byte {
	var bytes [commandLength]byte

	for i, c := range command {
		bytes[i] = byte(c)
	}

	return bytes[:]
}

// bytesToCommand extracts command from bytes
func bytesToCommand(bytes []byte) string {
	var command []byte

	for _, b := range bytes {
		if b != 0x0 {
			command = append(command, b)
		}
	}

	return string(command)
}

// gobEncode encodes data using gob
func gobEncode(data any) []byte {
	var buff bytes.Buffer

	enc := gob.NewEncoder(&buff)
	err := enc.Encode(data)
	if err != nil {
		log.Panic(err)
	}

	return buff.Bytes()
}
```

---

### Junior → FAANG: P2P Networking as a Distributed Systems Foundation

P2P networking in blockchain systems is built on the same primitives you use in any distributed system: TCP connections, message framing, peer discovery, and gossip protocols. The blockchain-specific layer adds a few key requirements: messages must be authenticated (using node identity keys), the network must be resistant to eclipse attacks (an attacker controlling all your peers), and the gossip protocol must propagate transactions and blocks within latency bounds that support the chain's target block time.

The prerequisite gap most juniors need to close is familiarity with Go's `net` package and specifically with managing long-lived connections that can fail and must be reconnected. Blockchain node p2p layers use persistent connections to a fixed peer set, not request-response HTTP. Understanding how to write a TCP server in Go that handles concurrent connections with proper goroutine lifecycle management (using `context.Context` for cancellation) is the baseline skill.

For interview entry points, be able to explain the devp2p protocol (used by go-ethereum), its node identity model (each node has an ECDSA key pair and a `NodeID` derived from the public key), and how the Kademlia-based DHT is used for peer discovery. The RLPx transport layer that encrypts devp2p connections uses an ECDH handshake similar in structure to TLS but using Ethereum's secp256k1 curves. Knowing this level of detail distinguishes candidates who have read the source from those who have only used the API.

First-job habit: when your node is not syncing or is missing transactions, the first debugging step is checking your peer count and peer quality. A node with fewer than five peers or with all peers from the same ISP or AS (autonomous system) may be partially eclipsed. Use `admin_peers` on the JSON-RPC interface to inspect peer details, and configure static peers or trusted peer lists for production nodes.

### Senior @ FAANG: P2P Network Architecture and Attack Surface Management

At staff level, the p2p network is both infrastructure and attack surface. The eclipse attack, where an attacker gains control of all inbound and outbound connections of a target node, allows the attacker to feed the target a false view of the chain. Mitigations include: enforcing diversity of peer IP ranges (no more than N peers from the same /24 subnet), maintaining a set of static trusted peers that are checked before accepting other connections, and rotating the peer set periodically. Production Ethereum nodes at FAANG-adjacent companies have these configurations codified and enforced through infrastructure-as-code.

The gossip protocol design has direct impact on transaction inclusion latency and MEV dynamics. Ethereum's current gossip model (Hive protocol, later Snap sync, and Portal network for stateless clients) has been evolving toward more efficient propagation patterns. A node that receives a block first has an advantage in the MEV supply chain: it can see the full block contents before slower peers and make faster decisions about the next block's contents. Staff engineers at companies that participate in block building or searching understand the p2p topology as a competitive resource.

libp2p (used by the Ethereum consensus layer clients: Prysm, Lighthouse, Teku, Nimbus, Lodestar) provides a modular p2p framework that is distinct from devp2p used by the execution layer. The split architecture introduced by the Beacon Chain means that production Ethereum infrastructure must operate two separate p2p stacks and understand where they interact (through the Engine API) and where they do not. ADRs for Ethereum node deployment must address both stacks.

Distributed denial of service resistance in p2p networks requires rate limiting at the connection and message level, not just at the application boundary. go-ethereum implements per-peer message rate limiting for several protocol message types. Staff engineers review these limits against their node's capacity profile and adjust them when running nodes on high-resource hardware that can handle faster peers without being overwhelmed.

Network topology modeling is a staff-level skill for blockchain infrastructure. Understanding that your nodes are clustered in one cloud region means that a regional outage could isolate your entire peer set. Geographic distribution of nodes, diversity of network providers, and fallback to trusted peer lists are all part of a resilient p2p network design. This work is documented in infrastructure ADRs and revisited during capacity planning.

Bar-raiser signals: explaining how a BGP hijack can affect a blockchain node's peer connections and what mitigations exist at the application layer, or designing a p2p monitoring system that detects when a production node is being eclipsed based on observable symptoms (diverging chain tips, missing transactions that are visible on block explorers). These topics test operational depth that cannot be obtained from documentation alone.

The Portal Network (EIP-4444 and related work) represents a modern evolution of Ethereum p2p that distributes historical data across a DHT rather than requiring every node to store a full archive. Staff engineers evaluating infrastructure requirements for archive-dependent use cases (e.g., backfilling transaction history, serving historical state proofs) need to track Portal Network readiness and design their systems to either rely on it or maintain their own archive nodes as the network transitions.

---
