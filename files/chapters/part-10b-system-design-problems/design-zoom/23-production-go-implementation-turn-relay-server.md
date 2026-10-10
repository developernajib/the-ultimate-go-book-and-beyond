## Production Go Implementation: TURN Relay Server

A TURN (Traversal Using Relays around NAT) relay server handles media relay when direct peer-to-peer connections fail. This is critical for enterprise networks with symmetric NATs and strict firewalls.

Be clear about what TURN costs before writing any of it. STUN is nearly free: it tells a client its public address and then steps aside, and the media flows directly. TURN is the opposite. Every byte of media arrives at the relay and leaves it again, so a relayed call consumes double the bandwidth on your own network and adds a hop of latency. It exists because 10-20% of sessions in the wild have no other path, rising sharply on locked-down corporate networks where the only escape is TURN over TCP or TLS on port 443. The whole design goal is to keep that fraction low and serve it cheaply.

Two things dominate correctness here. The first is the data path: a relay handles tens of thousands of packets per second per allocation, so the per-packet path must not allocate a socket, spawn a goroutine, or take a global lock. Each allocation owns exactly one UDP socket for its entire life, and packets are forwarded on it. The second is authentication. A TURN server that anyone can allocate on is an open relay: strangers will find it and use your bandwidth to proxy their own traffic. The credentials below are the standard ephemeral scheme (the "TURN REST API"), where the username carries an expiry timestamp and the password is derived from a shared secret, so a leaked credential dies on its own.

The response *encoders* at the bottom are left as stubs to keep this listing to a readable length. Everything that parses untrusted input, authenticates it, and moves media is real, because those are the parts where the bugs live.

```go
package turn

import (
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// --- TURN Allocation Types ---

// Allocation represents a TURN relay allocation for a single client.
// Each allocation gets a unique relay address that the client uses
// to send/receive media through the TURN server.
type Allocation struct {
	ID         string
	ClientAddr *net.UDPAddr // client's actual address
	RelayAddr  *net.UDPAddr // allocated relay address on TURN server
	Username   string
	Realm      string

	// relayConn is this allocation's one and only relay socket, opened
	// when the allocation is created and reused for every packet in both
	// directions. Dialing a fresh socket per packet, as a naive relay
	// does, costs several syscalls on a path that carries tens of
	// thousands of packets per second, and it cannot even bind: the
	// listener below already holds this address.
	relayConn *net.UDPConn

	// done stops relayListener. Without it the goroutine survives an
	// explicit deallocation and blocks on a socket nobody will ever
	// send to, for the life of the process.
	done      chan struct{}
	closeOnce sync.Once

	CreatedAt time.Time
	BytesSent atomic.Int64
	BytesRecv atomic.Int64

	mu          sync.RWMutex
	expiresAt   time.Time
	Permissions map[string]time.Time    // peer IP -> expiry
	Channels    map[uint16]*net.UDPAddr // channel number -> peer addr
}

// IsExpired checks if the allocation has timed out (default 10 minutes).
// It reads expiresAt under the lock because Refresh writes it from the
// server's packet loop while the relay listener is polling this.
func (a *Allocation) IsExpired() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return time.Now().After(a.expiresAt)
}

// Close releases the relay socket and stops the listener, exactly once.
func (a *Allocation) Close() {
	a.closeOnce.Do(func() {
		close(a.done)
		a.relayConn.Close()
	})
}

// HasPermission checks if a peer is allowed to send through this allocation.
func (a *Allocation) HasPermission(peerIP string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	expiry, exists := a.Permissions[peerIP]
	return exists && time.Now().Before(expiry)
}

// AddPermission grants a peer permission to send through this allocation.
func (a *Allocation) AddPermission(peerIP string, lifetime time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.Permissions[peerIP] = time.Now().Add(lifetime)
}

// Refresh extends the allocation lifetime.
func (a *Allocation) Refresh(lifetime time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.expiresAt = time.Now().Add(lifetime)
}

// --- TURN Server ---

// TURNServer manages relay allocations and forwards media packets.
type TURNServer struct {
	listenAddr     *net.UDPAddr
	conn           *net.UDPConn
	allocations    map[string]*Allocation // client addr string -> allocation
	relayMap       map[string]*Allocation // relay addr string -> allocation
	mu             sync.RWMutex
	relayPortMin   int
	relayPortMax   int
	nextPort       atomic.Int32
	realm          string
	sharedSecret   []byte
	maxAllocations int

	// Metrics
	totalAllocations atomic.Int64
	activeRelays     atomic.Int64
	bytesRelayed     atomic.Int64
}

// TURNConfig holds configuration for the TURN server.
type TURNConfig struct {
	ListenAddr     string
	RelayPortMin   int
	RelayPortMax   int
	Realm          string
	SharedSecret   string
	MaxAllocations int
}

// NewTURNServer creates and initializes a TURN relay server.
func NewTURNServer(cfg TURNConfig) (*TURNServer, error) {
	addr, err := net.ResolveUDPAddr("udp", cfg.ListenAddr)
	if err != nil {
		return nil, fmt.Errorf("resolve listen addr: %w", err)
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen UDP: %w", err)
	}

	// Set large read/write buffers for high-throughput media relay
	conn.SetReadBuffer(16 * 1024 * 1024) // 16MB
	conn.SetWriteBuffer(16 * 1024 * 1024)

	s := &TURNServer{
		listenAddr:     addr,
		conn:           conn,
		allocations:    make(map[string]*Allocation),
		relayMap:       make(map[string]*Allocation),
		relayPortMin:   cfg.RelayPortMin,
		relayPortMax:   cfg.RelayPortMax,
		realm:          cfg.Realm,
		sharedSecret:   []byte(cfg.SharedSecret),
		maxAllocations: cfg.MaxAllocations,
	}
	s.nextPort.Store(int32(cfg.RelayPortMin))
	return s, nil
}

// Serve starts the main TURN packet processing loop.
func (s *TURNServer) Serve(ctx context.Context) error {
	// Start allocation cleanup goroutine
	go s.cleanupExpiredAllocations(ctx)

	buf := make([]byte, 65535) // max UDP packet
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		s.conn.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, remoteAddr, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			return fmt.Errorf("read UDP: %w", err)
		}

		// Handle inline. Spawning a goroutine per packet looks like
		// concurrency and behaves like a denial of service: at relay
		// rates this is tens of thousands of goroutines per second, each
		// with its own copied buffer, and it reorders the media stream
		// for no benefit. The work here is a map lookup and a socket
		// write. Scale by running more instances, or by sharding the
		// read loop across sockets with SO_REUSEPORT, not by fanning out
		// per datagram.
		s.handlePacket(buf[:n], remoteAddr)
	}
}

// handlePacket routes incoming packets to the appropriate handler.
func (s *TURNServer) handlePacket(data []byte, from *net.UDPAddr) {
	if isSTUNMessage(data) {
		s.handleSTUN(data, from)
		return
	}

	// Check if this is a ChannelData message (first two bits = 01)
	if len(data) >= 4 && data[0]&0xC0 == 0x40 {
		s.handleChannelData(data, from)
		return
	}
}

// handleSTUN processes STUN/TURN control messages.
func (s *TURNServer) handleSTUN(data []byte, from *net.UDPAddr) {
	msgType := parseSTUNMessageType(data)

	switch msgType {
	case StunAllocateRequest:
		s.handleAllocateRequest(data, from)
	case StunRefreshRequest:
		s.handleRefreshRequest(data, from)
	case StunCreatePermission:
		s.handleCreatePermission(data, from)
	case StunChannelBind:
		s.handleChannelBind(data, from)
	case StunSendIndication:
		s.handleSendIndication(data, from)
	}
}

// handleAllocateRequest creates a new relay allocation.
func (s *TURNServer) handleAllocateRequest(data []byte, from *net.UDPAddr) {
	// Authenticate the request
	username, valid := s.authenticateRequest(data)
	if !valid {
		// A real server answers the first, unauthenticated Allocate with
		// 401 plus a REALM and a fresh NONCE, and the client retries with
		// credentials. Skipping the nonce entirely invites replay.
		s.sendError(from, 401, "Unauthorized")
		return
	}

	s.mu.Lock()

	// Check if client already has an allocation
	clientKey := from.String()
	if _, exists := s.allocations[clientKey]; exists {
		s.mu.Unlock()
		s.sendError(from, 437, "Allocation Mismatch")
		return
	}

	// Check max allocations
	if len(s.allocations) >= s.maxAllocations {
		s.mu.Unlock()
		s.sendError(from, 486, "Allocation Quota Reached")
		return
	}

	// Take the relay socket and keep it. The earlier version probed a
	// port by opening and immediately closing a listener, then reopened
	// it later in relayListener: between those two moments any other
	// goroutine could take the port.
	relayConn, err := s.allocateRelayConn()
	if err != nil {
		s.mu.Unlock()
		s.sendError(from, 508, "Insufficient Capacity")
		return
	}

	relayAddr := relayConn.LocalAddr().(*net.UDPAddr)

	alloc := &Allocation{
		ID:          fmt.Sprintf("alloc-%s-%d", from.IP.String(), time.Now().UnixNano()),
		ClientAddr:  from,
		RelayAddr:   relayAddr,
		relayConn:   relayConn,
		done:        make(chan struct{}),
		Username:    username,
		Realm:       s.realm,
		Permissions: make(map[string]time.Time),
		Channels:    make(map[uint16]*net.UDPAddr),
		CreatedAt:   time.Now(),
		expiresAt:   time.Now().Add(10 * time.Minute),
	}

	s.allocations[clientKey] = alloc
	s.relayMap[relayAddr.String()] = alloc
	s.totalAllocations.Add(1)
	s.activeRelays.Add(1)
	s.mu.Unlock()

	// Start relay listener for this allocation
	go s.relayListener(alloc)

	// Send success response with relay address
	s.sendAllocateSuccess(from, alloc)
}

// relayListener reads from the allocation's relay socket and forwards to
// the client. It exits on Close as well as on expiry, so an explicit
// deallocation stops it immediately instead of leaving it parked.
func (s *TURNServer) relayListener(alloc *Allocation) {
	defer alloc.Close()

	buf := make([]byte, 65535)
	for {
		select {
		case <-alloc.done:
			return
		default:
		}

		if alloc.IsExpired() {
			return
		}

		alloc.relayConn.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, peerAddr, err := alloc.relayConn.ReadFromUDP(buf)
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			return // socket closed by Close, or a real error
		}

		// Check permission. This is the check that keeps the relay from
		// being an open proxy: without it, anyone who learns the relay
		// address can push traffic at the client through your server.
		if !alloc.HasPermission(peerAddr.IP.String()) {
			continue // silently drop - no permission
		}

		// Forward to client as Data Indication
		alloc.BytesRecv.Add(int64(n))
		s.bytesRelayed.Add(int64(n))
		s.sendDataIndication(alloc.ClientAddr, peerAddr, buf[:n])
	}
}

// handleSendIndication relays data from client to peer via allocation.
func (s *TURNServer) handleSendIndication(data []byte, from *net.UDPAddr) {
	s.mu.RLock()
	alloc, exists := s.allocations[from.String()]
	s.mu.RUnlock()
	if !exists {
		return
	}

	peerAddr, payload := parseSendIndication(data)
	if peerAddr == nil {
		return
	}

	if !alloc.HasPermission(peerAddr.IP.String()) {
		return
	}

	// Write on the allocation's existing relay socket. Calling
	// net.DialUDP here, once per packet, would be wrong twice over: it
	// burns socket setup and teardown syscalls on the hottest path in
	// the server, and it tries to bind alloc.RelayAddr while
	// relayListener is already listening on it, so it simply fails.
	if _, err := alloc.relayConn.WriteToUDP(payload, peerAddr); err != nil {
		return
	}
	alloc.BytesSent.Add(int64(len(payload)))
	s.bytesRelayed.Add(int64(len(payload)))
}

// handleChannelData provides a more efficient relay path using channel numbers.
func (s *TURNServer) handleChannelData(data []byte, from *net.UDPAddr) {
	if len(data) < 4 {
		return
	}

	channelNum := uint16(data[0])<<8 | uint16(data[1])
	length := uint16(data[2])<<8 | uint16(data[3])

	if int(length)+4 > len(data) {
		return
	}

	s.mu.RLock()
	alloc, exists := s.allocations[from.String()]
	s.mu.RUnlock()
	if !exists {
		return
	}

	alloc.mu.RLock()
	peerAddr, hasChan := alloc.Channels[channelNum]
	alloc.mu.RUnlock()
	if !hasChan {
		return
	}

	// Direct relay via pre-bound channel: the most efficient path. A
	// ChannelData header is 4 bytes against the ~36 a Send indication
	// needs, which is why steady-state media uses channels.
	if _, err := alloc.relayConn.WriteToUDP(data[4:4+length], peerAddr); err != nil {
		return
	}
	alloc.BytesSent.Add(int64(length))
	s.bytesRelayed.Add(int64(length))
}

// handleCreatePermission allows a peer to send data through the allocation.
func (s *TURNServer) handleCreatePermission(data []byte, from *net.UDPAddr) {
	s.mu.RLock()
	alloc, exists := s.allocations[from.String()]
	s.mu.RUnlock()
	if !exists {
		s.sendError(from, 437, "Allocation Mismatch")
		return
	}

	peerIP := parsePeerAddress(data)
	alloc.AddPermission(peerIP, 5*time.Minute)
	s.sendSuccess(from, StunCreatePermission)
}

// handleChannelBind binds a channel number to a peer address for efficient relay.
func (s *TURNServer) handleChannelBind(data []byte, from *net.UDPAddr) {
	s.mu.RLock()
	alloc, exists := s.allocations[from.String()]
	s.mu.RUnlock()
	if !exists {
		return
	}

	channelNum, peerAddr := parseChannelBind(data)
	if channelNum < 0x4000 || channelNum > 0x7FFE {
		s.sendError(from, 400, "Bad Request")
		return
	}

	alloc.mu.Lock()
	alloc.Channels[channelNum] = peerAddr
	alloc.mu.Unlock()

	s.sendSuccess(from, StunChannelBind)
}

// handleRefreshRequest extends or deallocates an allocation.
func (s *TURNServer) handleRefreshRequest(data []byte, from *net.UDPAddr) {
	lifetime := parseLifetime(data)

	s.mu.Lock()
	defer s.mu.Unlock()

	alloc, exists := s.allocations[from.String()]
	if !exists {
		s.sendError(from, 437, "Allocation Mismatch")
		return
	}

	if lifetime == 0 {
		// Deallocation. Closing releases the relay port and stops the
		// listener goroutine. Dropping the map entries alone would leak
		// both: the socket stays bound and the goroutine keeps polling
		// an allocation nothing references any more.
		delete(s.allocations, from.String())
		delete(s.relayMap, alloc.RelayAddr.String())
		s.activeRelays.Add(-1)
		alloc.Close()
	} else {
		alloc.Refresh(time.Duration(lifetime) * time.Second)
	}

	s.sendRefreshSuccess(from, lifetime)
}

// authenticateRequest validates a request's MESSAGE-INTEGRITY against the
// ephemeral credentials derived from the shared secret.
//
// The scheme (the "TURN REST API") works like this:
//
//	username = "<unix-expiry>:<user>"
//	password = base64(HMAC-SHA1(sharedSecret, username))
//	key      = MD5(username ":" realm ":" password)   [RFC 5766 long-term]
//	MESSAGE-INTEGRITY = HMAC-SHA1(key, message)
//
// The signalling server hands a client that username and password when it
// joins a meeting. Nothing needs a user database, and a stolen credential
// expires by itself, which is the entire point of embedding the timestamp
// in the username.
//
// MD5 and SHA-1 are not choices, they are what RFC 5766 specifies. They
// are load-bearing for interop, not for security: the security rests on
// the shared secret and the expiry, so do not "modernize" them and expect
// any client to still connect.
func (s *TURNServer) authenticateRequest(data []byte) (string, bool) {
	usernameAttr, ok := stunAttr(data, attrUsername)
	if !ok {
		return "", false
	}
	username := string(usernameAttr)

	key, ok := s.credentialKey(username)
	if !ok {
		return "", false
	}
	if !verifyMessageIntegrity(data, key) {
		return "", false
	}
	return username, true
}

// credentialKey rebuilds the long-term key for a username, rejecting the
// credential if its embedded expiry has passed.
func (s *TURNServer) credentialKey(username string) ([]byte, bool) {
	expiryStr, _, found := strings.Cut(username, ":")
	if !found {
		return nil, false
	}
	expiry, err := strconv.ParseInt(expiryStr, 10, 64)
	if err != nil {
		return nil, false
	}
	// Without this check the credential is valid forever and the relay is
	// one leaked username away from being an open proxy.
	if time.Now().Unix() > expiry {
		return nil, false
	}

	mac := hmac.New(sha1.New, s.sharedSecret)
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	sum := md5.Sum([]byte(username + ":" + s.realm + ":" + password))
	return sum[:], true
}

// verifyMessageIntegrity checks the HMAC-SHA1 over the message.
//
// The subtlety that trips people up: the digest is computed over the
// message with its header length field rewritten to count everything
// through the end of MESSAGE-INTEGRITY, ignoring any attributes after it.
// Hashing the raw bytes as they arrived produces a digest that never
// matches a spec-compliant client.
func verifyMessageIntegrity(msg []byte, key []byte) bool {
	off, ok := stunAttrOffset(msg, attrMessageIntegrity)
	if !ok || off+4+sha1.Size > len(msg) {
		return false
	}
	given := msg[off+4 : off+4+sha1.Size]

	prefix := make([]byte, off)
	copy(prefix, msg[:off])
	// Length counts the attributes only (header is 20 bytes), through the
	// end of the 24-byte MESSAGE-INTEGRITY attribute.
	binary.BigEndian.PutUint16(prefix[2:4], uint16(off+4))

	mac := hmac.New(sha1.New, key)
	mac.Write(prefix)
	// hmac.Equal, not bytes.Equal: comparison must not leak, via timing,
	// how many leading bytes of the digest were correct.
	return hmac.Equal(mac.Sum(nil), given)
}

// cleanupExpiredAllocations periodically removes timed-out allocations.
func (s *TURNServer) cleanupExpiredAllocations(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			expired := make([]*Allocation, 0)
			for key, alloc := range s.allocations {
				if alloc.IsExpired() {
					delete(s.allocations, key)
					delete(s.relayMap, alloc.RelayAddr.String())
					s.activeRelays.Add(-1)
					expired = append(expired, alloc)
				}
			}
			s.mu.Unlock()

			// Close outside the lock: Close touches a socket, and
			// holding the server's only mutex across a syscall stalls
			// every allocate and refresh in flight.
			for _, alloc := range expired {
				alloc.Close()
			}
		}
	}
}

// allocateRelayConn binds the next free relay port and returns the socket
// itself. Returning a port number instead would leave a window in which
// the port is free again, and the caller would have to race to rebind it.
func (s *TURNServer) allocateRelayConn() (*net.UDPConn, error) {
	for i := 0; i <= s.relayPortMax-s.relayPortMin; i++ {
		port := int(s.nextPort.Add(1))
		if port > s.relayPortMax {
			s.nextPort.Store(int32(s.relayPortMin))
			port = s.relayPortMin
		}
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: s.listenAddr.IP, Port: port})
		if err == nil {
			return conn, nil
		}
	}
	return nil, fmt.Errorf("no relay port free in range %d-%d", s.relayPortMin, s.relayPortMax)
}

// --- STUN message parsing ---

// STUN message types: the method in the low bits, the class encoded in
// bits 4 and 8. Allocate/Refresh/CreatePermission/ChannelBind are
// requests (class 00), Send is an indication (class 01).
const (
	StunAllocateRequest  = 0x0003
	StunRefreshRequest   = 0x0004
	StunCreatePermission = 0x0008
	StunChannelBind      = 0x0009
	StunSendIndication   = 0x0016
)

// STUN attribute types (RFC 5389, RFC 5766).
const (
	attrUsername         = 0x0006
	attrMessageIntegrity = 0x0008
	attrChannelNumber    = 0x000C
	attrLifetime         = 0x000D
	attrXORPeerAddress   = 0x0012
	attrData             = 0x0013
)

// magicCookie identifies a STUN message and salts the XOR-ed addresses.
const magicCookie uint32 = 0x2112A442

func isSTUNMessage(data []byte) bool {
	// The two leading zero bits are necessary but nowhere near
	// sufficient: plenty of media bytes start that way. The magic cookie
	// is what actually distinguishes STUN from anything else on the port.
	return len(data) >= 20 &&
		data[0]&0xC0 == 0x00 &&
		binary.BigEndian.Uint32(data[4:8]) == magicCookie
}

func parseSTUNMessageType(data []byte) int {
	if len(data) < 2 {
		return 0
	}
	return int(binary.BigEndian.Uint16(data[0:2]))
}

// stunAttrOffset walks the TLV attribute list and returns the offset of
// the requested attribute's header.
//
// Every bound is checked against the real buffer length. This walk runs on
// unauthenticated input from the open internet, so a malformed length
// field must produce a miss, never a panic or a read past the end.
func stunAttrOffset(msg []byte, want uint16) (int, bool) {
	if len(msg) < 20 {
		return 0, false
	}
	for off := 20; off+4 <= len(msg); {
		typ := binary.BigEndian.Uint16(msg[off : off+2])
		length := int(binary.BigEndian.Uint16(msg[off+2 : off+4]))
		if off+4+length > len(msg) {
			return 0, false
		}
		if typ == want {
			return off, true
		}
		off += 4 + length
		// Attributes are padded to a 4-byte boundary. Forgetting this is
		// the classic STUN parsing bug: the walk drifts out of alignment
		// and every later attribute reads as garbage.
		if pad := length % 4; pad != 0 {
			off += 4 - pad
		}
	}
	return 0, false
}

func stunAttr(msg []byte, want uint16) ([]byte, bool) {
	off, ok := stunAttrOffset(msg, want)
	if !ok {
		return nil, false
	}
	length := int(binary.BigEndian.Uint16(msg[off+2 : off+4]))
	return msg[off+4 : off+4+length], true
}

// parseXORAddress decodes an XOR-MAPPED-ADDRESS style attribute. The
// address is XOR-ed with the magic cookie (and, for IPv6, the transaction
// ID) specifically so that NATs rewriting payloads cannot recognise and
// mangle an embedded IP.
func parseXORAddress(v []byte, transactionID []byte) *net.UDPAddr {
	if len(v) < 8 {
		return nil
	}
	port := binary.BigEndian.Uint16(v[2:4]) ^ uint16(magicCookie>>16)

	switch v[1] { // address family
	case 0x01: // IPv4
		ip := make(net.IP, 4)
		binary.BigEndian.PutUint32(ip, binary.BigEndian.Uint32(v[4:8])^magicCookie)
		return &net.UDPAddr{IP: ip, Port: int(port)}
	case 0x02: // IPv6
		if len(v) < 20 || len(transactionID) < 12 {
			return nil
		}
		var mask [16]byte
		binary.BigEndian.PutUint32(mask[0:4], magicCookie)
		copy(mask[4:], transactionID)
		ip := make(net.IP, 16)
		for i := range ip {
			ip[i] = v[4+i] ^ mask[i]
		}
		return &net.UDPAddr{IP: ip, Port: int(port)}
	}
	return nil
}

func transactionID(msg []byte) []byte {
	if len(msg) < 20 {
		return nil
	}
	return msg[8:20]
}

// parseSendIndication extracts the peer address and payload a client wants
// relayed.
func parseSendIndication(data []byte) (*net.UDPAddr, []byte) {
	peer, ok := stunAttr(data, attrXORPeerAddress)
	if !ok {
		return nil, nil
	}
	addr := parseXORAddress(peer, transactionID(data))
	if addr == nil {
		return nil, nil
	}
	payload, ok := stunAttr(data, attrData)
	if !ok {
		return nil, nil
	}
	return addr, payload
}

func parsePeerAddress(data []byte) string {
	peer, ok := stunAttr(data, attrXORPeerAddress)
	if !ok {
		return ""
	}
	addr := parseXORAddress(peer, transactionID(data))
	if addr == nil {
		return ""
	}
	return addr.IP.String()
}

func parseChannelBind(data []byte) (uint16, *net.UDPAddr) {
	ch, ok := stunAttr(data, attrChannelNumber)
	if !ok || len(ch) < 2 {
		return 0, nil
	}
	peer, ok := stunAttr(data, attrXORPeerAddress)
	if !ok {
		return 0, nil
	}
	return binary.BigEndian.Uint16(ch[0:2]), parseXORAddress(peer, transactionID(data))
}

// parseLifetime returns the requested lifetime in seconds, defaulting to
// 600 only when the attribute is absent.
//
// Returning a hardcoded 600 unconditionally, as a stub does, quietly
// breaks deallocation: a client asking to tear down its allocation sends
// LIFETIME=0, the server reads 600, and the allocation is renewed instead
// of released. Relay ports then leak until the expiry sweep catches them.
func parseLifetime(data []byte) int {
	v, ok := stunAttr(data, attrLifetime)
	if !ok || len(v) < 4 {
		return 600
	}
	return int(binary.BigEndian.Uint32(v[0:4]))
}

// --- Response encoders (omitted for length) ---
//
// These serialize replies: a success response carries XOR-RELAYED-ADDRESS
// and LIFETIME, an error carries ERROR-CODE plus REALM and NONCE, and each
// is signed with MESSAGE-INTEGRITY using the same key as the request.

func (s *TURNServer) sendError(to *net.UDPAddr, code int, msg string)        {}
func (s *TURNServer) sendSuccess(to *net.UDPAddr, msgType int)               {}
func (s *TURNServer) sendAllocateSuccess(to *net.UDPAddr, alloc *Allocation) {}
func (s *TURNServer) sendRefreshSuccess(to *net.UDPAddr, lifetime int)       {}
func (s *TURNServer) sendDataIndication(to, from *net.UDPAddr, data []byte)  {}
```

---
