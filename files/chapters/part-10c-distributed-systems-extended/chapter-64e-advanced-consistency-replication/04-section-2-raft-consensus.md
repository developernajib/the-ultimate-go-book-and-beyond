## Section 2: Raft Consensus

### 2.1 Raft State Machine

Raft achieves consensus by electing a single leader that replicates log entries to a majority quorum before considering them committed, providing strong consistency guarantees even in the presence of minority node failures. The following Go implementation builds a simplified Raft state machine covering leader election, log replication, and commit index advancement to make the algorithm's mechanics tangible.

```go
package raft

import (
	"context"
	"fmt"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

// Role represents a Raft node's role.
type Role int32

const (
	Follower  Role = 0
	Candidate Role = 1
	Leader    Role = 2
)

func (r Role) String() string {
	switch r {
	case Follower:
		return "Follower"
	case Candidate:
		return "Candidate"
	case Leader:
		return "Leader"
	default:
		return "Unknown"
	}
}

// LogEntry is a single entry in the Raft log.
type LogEntry struct {
	Term    uint64
	Index   uint64
	Command []byte
}

// Config holds Raft configuration.
type Config struct {
	NodeID          string
	Peers           []string
	ElectionTimeout time.Duration
	HeartbeatInterval time.Duration
	MaxLogEntries   int
}

// Node implements the Raft consensus algorithm.
type Node struct {
	cfg  Config
	mu   sync.Mutex

	// Persistent state (must be saved to stable storage before responding).
	currentTerm uint64
	votedFor    string // NodeID voted for in current term, or "".
	log         []LogEntry

	// Volatile state.
	role        atomic.Int32 // Role (Follower/Candidate/Leader).
	commitIndex uint64       // Index of highest log entry known to be committed.
	lastApplied uint64       // Index of highest log entry applied to state machine.

	// Leader-only volatile state (reinitialized after election).
	nextIndex  map[string]uint64 // For each peer: index of next log entry to send.
	matchIndex map[string]uint64 // For each peer: index of highest log entry known to be replicated.

	// Channels.
	heartbeat    chan struct{}  // Reset election timer.
	commitCh     chan LogEntry  // Apply to state machine.
	transport    Transport
	storage      Storage
}

// Transport defines the network layer for Raft RPCs.
type Transport interface {
	RequestVote(ctx context.Context, peer string, req VoteRequest) (VoteResponse, error)
	AppendEntries(ctx context.Context, peer string, req AppendEntriesRequest) (AppendEntriesResponse, error)
}

// Storage defines persistent storage for Raft state.
type Storage interface {
	SaveState(term uint64, votedFor string) error
	SaveLog(entries []LogEntry) error
	LoadState() (term uint64, votedFor string, err error)
	LoadLog() ([]LogEntry, error)
}

// VoteRequest is sent by a candidate to request votes.
type VoteRequest struct {
	Term         uint64
	CandidateID  string
	LastLogIndex uint64
	LastLogTerm  uint64
}

// VoteResponse is the response to a vote request.
type VoteResponse struct {
	Term        uint64
	VoteGranted bool
}

// AppendEntriesRequest is sent by the leader for heartbeats and log replication.
type AppendEntriesRequest struct {
	Term         uint64
	LeaderID     string
	PrevLogIndex uint64
	PrevLogTerm  uint64
	Entries      []LogEntry
	LeaderCommit uint64
}

// AppendEntriesResponse is the response to AppendEntries.
type AppendEntriesResponse struct {
	Term    uint64
	Success bool
	// Conflict optimization: helps leader find the right nextIndex faster.
	ConflictIndex uint64
	ConflictTerm  uint64
}

// New creates a new Raft node.
func New(cfg Config, transport Transport, storage Storage) (*Node, error) {
	n := &Node{
		cfg:        cfg,
		heartbeat:  make(chan struct{}, 1),
		commitCh:   make(chan LogEntry, 1000),
		transport:  transport,
		storage:    storage,
		nextIndex:  make(map[string]uint64),
		matchIndex: make(map[string]uint64),
	}
	n.role.Store(int32(Follower))

	// Restore persistent state.
	term, votedFor, err := storage.LoadState()
	if err != nil {
		return nil, fmt.Errorf("load state: %w", err)
	}
	n.currentTerm = term
	n.votedFor = votedFor

	log, err := storage.LoadLog()
	if err != nil {
		return nil, fmt.Errorf("load log: %w", err)
	}
	n.log = log

	return n, nil
}

// Run starts the Raft node's main loop.
func (n *Node) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		role := Role(n.role.Load())
		switch role {
		case Follower:
			n.runFollower(ctx)
		case Candidate:
			n.runCandidate(ctx)
		case Leader:
			n.runLeader(ctx)
		}
	}
}

// runFollower runs the follower state until timeout or role change.
func (n *Node) runFollower(ctx context.Context) {
	timeout := n.electionTimeout()
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-n.heartbeat:
			// Received heartbeat from leader - reset timer.
			if !timer.Stop() {
				<-timer.C
			}
			timer.Reset(n.electionTimeout())
		case <-timer.C:
			// Election timeout - become candidate.
			n.becomeCandidate()
			return
		}
	}
}

// runCandidate runs an election.
func (n *Node) runCandidate(ctx context.Context) {
	n.mu.Lock()
	n.currentTerm++
	n.votedFor = n.cfg.NodeID
	_ = n.storage.SaveState(n.currentTerm, n.votedFor)
	term := n.currentTerm
	lastLogIndex, lastLogTerm := n.lastLogInfo()
	n.mu.Unlock()

	// Request votes from all peers.
	voteCh := make(chan bool, len(n.cfg.Peers))
	for _, peer := range n.cfg.Peers {
		go func(peer string) {
			req := VoteRequest{
				Term:         term,
				CandidateID:  n.cfg.NodeID,
				LastLogIndex: lastLogIndex,
				LastLogTerm:  lastLogTerm,
			}
			resp, err := n.transport.RequestVote(ctx, peer, req)
			if err != nil {
				voteCh <- false
				return
			}
			n.mu.Lock()
			if resp.Term > n.currentTerm {
				n.stepDown(resp.Term)
			}
			n.mu.Unlock()
			voteCh <- resp.VoteGranted
		}(peer)
	}

	// Count votes (including self).
	votes := 1
	needed := (len(n.cfg.Peers)+1)/2 + 1
	timer := time.NewTimer(n.electionTimeout())
	defer timer.Stop()

	for i := 0; i < len(n.cfg.Peers); i++ {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			// Election timed out - retry as candidate.
			return
		case granted := <-voteCh:
			if granted {
				votes++
				if votes >= needed {
					n.becomeLeader()
					return
				}
			}
		}
	}
}

// runLeader handles leader responsibilities: heartbeats and log replication.
func (n *Node) runLeader(ctx context.Context) {
	// Initialize nextIndex and matchIndex.
	n.mu.Lock()
	lastIdx, _ := n.lastLogInfo()
	for _, peer := range n.cfg.Peers {
		n.nextIndex[peer] = lastIdx + 1
		n.matchIndex[peer] = 0
	}
	n.mu.Unlock()

	ticker := time.NewTicker(n.cfg.HeartbeatInterval)
	defer ticker.Stop()

	// Send initial heartbeats immediately.
	n.sendHeartbeats(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if Role(n.role.Load()) != Leader {
				return
			}
			n.sendHeartbeats(ctx)
			n.advanceCommitIndex()
		}
	}
}

func (n *Node) sendHeartbeats(ctx context.Context) {
	n.mu.Lock()
	term := n.currentTerm
	commitIdx := n.commitIndex
	n.mu.Unlock()

	for _, peer := range n.cfg.Peers {
		go func(peer string) {
			n.mu.Lock()
			nextIdx := n.nextIndex[peer]
			prevLogIndex := nextIdx - 1
			var prevLogTerm uint64
			if prevLogIndex > 0 && prevLogIndex <= uint64(len(n.log)) {
				prevLogTerm = n.log[prevLogIndex-1].Term
			}
			// Send all entries from nextIndex onwards (or empty for heartbeat).
			var entries []LogEntry
			if nextIdx <= uint64(len(n.log)) {
				entries = n.log[nextIdx-1:]
			}
			n.mu.Unlock()

			req := AppendEntriesRequest{
				Term:         term,
				LeaderID:     n.cfg.NodeID,
				PrevLogIndex: prevLogIndex,
				PrevLogTerm:  prevLogTerm,
				Entries:      entries,
				LeaderCommit: commitIdx,
			}

			resp, err := n.transport.AppendEntries(ctx, peer, req)
			if err != nil {
				return
			}

			n.mu.Lock()
			defer n.mu.Unlock()

			if resp.Term > n.currentTerm {
				n.stepDown(resp.Term)
				return
			}

			if resp.Success {
				// Update nextIndex and matchIndex for this peer.
				if len(entries) > 0 {
					lastSent := entries[len(entries)-1].Index
					n.nextIndex[peer] = lastSent + 1
					n.matchIndex[peer] = lastSent
				}
			} else {
				// Decrement nextIndex and retry.
				if n.nextIndex[peer] > 1 {
					n.nextIndex[peer]--
				}
			}
		}(peer)
	}
}

// HandleVoteRequest processes an incoming vote request.
func (n *Node) HandleVoteRequest(req VoteRequest) VoteResponse {
	n.mu.Lock()
	defer n.mu.Unlock()

	if req.Term < n.currentTerm {
		return VoteResponse{Term: n.currentTerm, VoteGranted: false}
	}

	if req.Term > n.currentTerm {
		n.stepDown(req.Term)
	}

	lastLogIndex, lastLogTerm := n.lastLogInfo()
	logUpToDate := req.LastLogTerm > lastLogTerm ||
		(req.LastLogTerm == lastLogTerm && req.LastLogIndex >= lastLogIndex)

	grant := (n.votedFor == "" || n.votedFor == req.CandidateID) && logUpToDate

	if grant {
		n.votedFor = req.CandidateID
		_ = n.storage.SaveState(n.currentTerm, n.votedFor)
		// Signal heartbeat to reset election timer.
		select {
		case n.heartbeat <- struct{}{}:
		default:
		}
	}

	return VoteResponse{Term: n.currentTerm, VoteGranted: grant}
}

// HandleAppendEntries processes an incoming AppendEntries RPC.
func (n *Node) HandleAppendEntries(req AppendEntriesRequest) AppendEntriesResponse {
	n.mu.Lock()
	defer n.mu.Unlock()

	if req.Term < n.currentTerm {
		return AppendEntriesResponse{Term: n.currentTerm, Success: false}
	}

	// Valid leader - reset election timer.
	select {
	case n.heartbeat <- struct{}{}:
	default:
	}

	if req.Term > n.currentTerm {
		n.stepDown(req.Term)
	}

	// Check log consistency.
	if req.PrevLogIndex > 0 {
		if req.PrevLogIndex > uint64(len(n.log)) {
			return AppendEntriesResponse{
				Term:          n.currentTerm,
				Success:       false,
				ConflictIndex: uint64(len(n.log)) + 1,
			}
		}
		if n.log[req.PrevLogIndex-1].Term != req.PrevLogTerm {
			conflictTerm := n.log[req.PrevLogIndex-1].Term
			// Find first entry with conflictTerm.
			var conflictIndex uint64
			for i, entry := range n.log {
				if entry.Term == conflictTerm {
					conflictIndex = uint64(i) + 1
					break
				}
			}
			return AppendEntriesResponse{
				Term:          n.currentTerm,
				Success:       false,
				ConflictIndex: conflictIndex,
				ConflictTerm:  conflictTerm,
			}
		}
	}

	// Append new entries (removing any conflicting ones first).
	for i, entry := range req.Entries {
		idx := req.PrevLogIndex + uint64(i) + 1
		if idx <= uint64(len(n.log)) {
			if n.log[idx-1].Term != entry.Term {
				// Conflict - truncate log from here.
				n.log = n.log[:idx-1]
				n.log = append(n.log, req.Entries[i:]...)
				break
			}
		} else {
			n.log = append(n.log, req.Entries[i:]...)
			break
		}
	}
	_ = n.storage.SaveLog(n.log)

	// Update commit index.
	if req.LeaderCommit > n.commitIndex {
		lastNewEntry := req.PrevLogIndex + uint64(len(req.Entries))
		if req.LeaderCommit < lastNewEntry {
			n.commitIndex = req.LeaderCommit
		} else {
			n.commitIndex = lastNewEntry
		}
		// Apply committed entries.
		n.applyCommitted()
	}

	return AppendEntriesResponse{Term: n.currentTerm, Success: true}
}

// Propose proposes a new command to the cluster (must be called on leader).
func (n *Node) Propose(ctx context.Context, command []byte) (uint64, error) {
	n.mu.Lock()
	if Role(n.role.Load()) != Leader {
		n.mu.Unlock()
		return 0, fmt.Errorf("not leader")
	}

	entry := LogEntry{
		Term:    n.currentTerm,
		Index:   uint64(len(n.log)) + 1,
		Command: command,
	}
	n.log = append(n.log, entry)
	_ = n.storage.SaveLog(n.log)
	n.mu.Unlock()

	return entry.Index, nil
}

// advanceCommitIndex advances the commit index on the leader.
// An entry can be committed if replicated on a majority of nodes.
func (n *Node) advanceCommitIndex() {
	n.mu.Lock()
	defer n.mu.Unlock()

	if Role(n.role.Load()) != Leader {
		return
	}

	for idx := uint64(len(n.log)); idx > n.commitIndex; idx-- {
		if n.log[idx-1].Term != n.currentTerm {
			continue // Only commit entries from current term (Raft safety rule).
		}

		replicated := 1 // Leader itself.
		for _, matchIdx := range n.matchIndex {
			if matchIdx >= idx {
				replicated++
			}
		}

		if replicated*2 > len(n.cfg.Peers)+1 {
			n.commitIndex = idx
			n.applyCommitted()
			break
		}
	}
}

// applyCommitted sends newly committed entries to the commit channel.
func (n *Node) applyCommitted() {
	for n.lastApplied < n.commitIndex {
		n.lastApplied++
		entry := n.log[n.lastApplied-1]
		select {
		case n.commitCh <- entry:
		default:
			// Buffer full - apply synchronously.
		}
	}
}

// CommitCh returns the channel for receiving committed log entries.
func (n *Node) CommitCh() <-chan LogEntry { return n.commitCh }

func (n *Node) becomeCandidate() {
	n.role.Store(int32(Candidate))
}

func (n *Node) becomeLeader() {
	n.role.Store(int32(Leader))
}

func (n *Node) stepDown(newTerm uint64) {
	n.currentTerm = newTerm
	n.votedFor = ""
	_ = n.storage.SaveState(n.currentTerm, n.votedFor)
	n.role.Store(int32(Follower))
}

func (n *Node) lastLogInfo() (index, term uint64) {
	if len(n.log) == 0 {
		return 0, 0
	}
	last := n.log[len(n.log)-1]
	return last.Index, last.Term
}

func (n *Node) electionTimeout() time.Duration {
	base := n.cfg.ElectionTimeout
	jitter := time.Duration(rand.Int64N(int64(base)))
	return base + jitter
}
```

### Junior → FAANG: Reading the Raft Implementation to Build Algorithmic Intuition

Raft is the distributed consensus algorithm most likely to appear in a FAANG system design interview because it underlies etcd, which underlies Kubernetes. Reading this implementation is not about memorizing code: it is about understanding the invariants that make it safe.

Three invariants to commit to memory: first, a node votes for at most one candidate per term (enforced by `votedFor` persisted to stable storage before responding). Second, a candidate's log must be at least as up-to-date as any voter's log before votes are granted (the `logUpToDate` check in `HandleVoteRequest`). Third, a leader can only commit entries from its current term, with older entries committed transitively. Violating any of these three invariants breaks safety.

The implementation bug most juniors introduce when re-implementing Raft is forgetting to persist state before responding to RPCs. The `SaveState` call must happen before the `VoteResponse` is returned, not after. If the process crashes between granting the vote and persisting that it granted the vote, it may grant a second vote in the same term to a different candidate after restart, which can elect two leaders in the same term.

Interview preparation: practice drawing the Raft leader election sequence on a whiteboard: the three states (follower, candidate, leader), the two RPCs (RequestVote, AppendEntries), and the transition triggers. Be able to explain what happens when an election timer fires on a follower that just received a heartbeat (the timer should be reset, no election starts).

For the `jitter` in `electionTimeout`: this is critical to prevent all followers from starting elections simultaneously. Without jitter in a 3-node cluster where the leader crashes, all three nodes time out within milliseconds of each other and split votes indefinitely.

### Senior @ FAANG: Operating and Extending Raft in Production Systems

The Raft implementation in this section is a teaching version. Production Raft (etcd, CockroachDB, TiKV) has a long list of additions that are invisible in the simplified code but critical for correctness and performance at scale.

Pre-vote phase: before incrementing its term and starting a real election, a candidate runs a pre-vote round to check whether it can win an election. This prevents a partitioned node with a high term from disrupting the cluster when it reconnects. Without pre-vote, a node that was isolated for a long time will have incremented its term many times and will force all other nodes to step down when it reconnects, causing unnecessary leadership churn.

Batching and pipelining: the heartbeat-driven replication in this implementation sends one batch of entries per heartbeat interval. Production leaders pipeline AppendEntries: they send the next batch before receiving an acknowledgment for the previous one, keeping the replication pipeline full. This is essential for keeping throughput high when replication latency is 5-10ms (cross-zone).

Log compaction and snapshot installation: the implementation here has no snapshotting. A production Raft node must snapshot the state machine periodically and discard the prefix of the log that is already captured in the snapshot. The snapshot installation RPC (InstallSnapshot) is particularly tricky because it must be idempotent and must not disrupt in-progress replication to faster peers.

Operational observability: every production Raft implementation needs metrics on election frequency (more than one election per 24 hours is a reliability signal), commit latency by percentile, replication lag per peer, and snapshot frequency. An etcd cluster that is snapshotting very frequently is a signal that the log is not being compacted fast enough relative to write throughput.

ADR for Raft vs Paxos selection: Raft's single-leader model simplifies the client-facing API (clients can always find the leader) but creates a bottleneck at the leader for all writes. Multi-Paxos allows multiple coordinators, which matters for high write throughput across geographic regions. Spanner uses Multi-Paxos for exactly this reason. If you are building a coordination service (like etcd) where write throughput is bounded by the coordination operations themselves (not user data), Raft is the right choice. If you are building a globally distributed database, Multi-Paxos or a Raft variant with leader leases and follower reads becomes necessary.

Bar-raiser signal: a senior candidate who has operated an etcd cluster in production can describe what a leadership election looks like in the metrics (sudden drop in commit throughput for 150-300ms, spike in election count metric, brief unavailability for write operations) and has opinions on tuning election timeout and heartbeat interval for their specific hardware and network environment.

---
