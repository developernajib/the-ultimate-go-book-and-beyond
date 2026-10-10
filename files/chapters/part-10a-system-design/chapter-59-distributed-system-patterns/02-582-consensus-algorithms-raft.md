## 59.2 Consensus Algorithms: Raft

Raft is a consensus algorithm designed for understandability while providing the same safety guarantees as Paxos. Where Paxos is notoriously difficult to implement correctly, Raft decomposes consensus into three distinct subproblems, leader election, log replication, and safety, that can be understood and tested independently.

### Raft State Machine

Every node in a Raft cluster is always in one of three states, Follower, Candidate, or Leader, and the `RaftNode` struct captures both the persistent state that must survive restarts (current term, voted-for peer, and log entries) and the volatile state that is recomputed on recovery (commit index and the per-peer `nextIndex` map). The randomized election timeout stored at construction time is critical to Raft's liveness guarantee: it ensures that nodes do not all start an election simultaneously, allowing one candidate to win a majority before others wake up. All mutable fields are protected by a single `sync.RWMutex` so that RPC handlers and the main loop can safely share state across goroutines.

```go
// raft/state.go
package raft

import (
    "math/rand/v2"
    "sync"
    "time"
)

// NodeState represents the state of a Raft node
type NodeState int

const (
    Follower NodeState = iota
    Candidate
    Leader
)

func (s NodeState) String() string {
    switch s {
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

// LogEntry represents a single entry in the Raft log
type LogEntry struct {
    Term    uint64      // Term when entry was received
    Index   uint64      // Position in the log
    Command any // Command to be applied to state machine
}

// RaftNode represents a single node in a Raft cluster
type RaftNode struct {
    mu sync.RWMutex

    // Persistent state (must survive restarts)
    id          string
    currentTerm uint64
    votedFor    string
    log         []LogEntry

    // Volatile state
    state       NodeState
    commitIndex uint64
    lastApplied uint64

    // Leader-only volatile state
    nextIndex   map[string]uint64 // For each peer: next log index to send
    matchIndex  map[string]uint64 // For each peer: highest log index known replicated

    // Cluster configuration
    peers []string

    // Channels
    appendEntriesCh chan *AppendEntriesRequest
    requestVoteCh   chan *RequestVoteRequest
    commitCh        chan LogEntry // Committed entries to apply
    applyCh         chan struct{} // Signals the applier goroutine

    // Timing
    electionTimeout  time.Duration
    heartbeatTimeout time.Duration
    lastHeartbeat    time.Time

    // State
    running bool
    stopCh  chan struct{}
}

// NewRaftNode creates a new Raft node
func NewRaftNode(id string, peers []string) *RaftNode {
    return &RaftNode{
        id:               id,
        currentTerm:      0,
        votedFor:         "",
        log:              make([]LogEntry, 0),
        state:            Follower,
        commitIndex:      0,
        lastApplied:      0,
        nextIndex:        make(map[string]uint64),
        matchIndex:       make(map[string]uint64),
        peers:            peers,
        appendEntriesCh:  make(chan *AppendEntriesRequest, 100),
        requestVoteCh:    make(chan *RequestVoteRequest, 100),
        commitCh:         make(chan LogEntry, 100),
        applyCh:          make(chan struct{}, 1),
        electionTimeout:  randomTimeout(150*time.Millisecond, 300*time.Millisecond),
        heartbeatTimeout: 50 * time.Millisecond,
        stopCh:           make(chan struct{}),
    }
}

func randomTimeout(min, max time.Duration) time.Duration {
    return min + time.Duration(rand.Int64N(int64(max-min)))
}
```

### Request Vote RPC

When a follower's election timer fires, it transitions to Candidate, increments its term, votes for itself, and broadcasts `RequestVoteRequest` messages to all peers. A node grants its vote only if it has not already voted in the current term and the candidate's log is at least as up-to-date as its own, compared first by last-log term, then by last-log index, which prevents a stale candidate from winning and overwriting committed entries. The `startElection` function collects responses on a buffered channel, counts votes concurrently, and immediately calls `becomeLeader` as soon as a strict majority is reached, without waiting for all peers to respond.

```go
// raft/vote.go
package raft

import "time"

// RequestVoteRequest is sent by candidates to gather votes
type RequestVoteRequest struct {
    Term         uint64 // Candidate's term
    CandidateID  string // Candidate requesting vote
    LastLogIndex uint64 // Index of candidate's last log entry
    LastLogTerm  uint64 // Term of candidate's last log entry
}

// RequestVoteResponse is the response to a vote request
type RequestVoteResponse struct {
    Term        uint64 // Current term, for candidate to update itself
    VoteGranted bool   // True if candidate received vote
}

// RequestVote handles incoming vote requests
func (n *RaftNode) RequestVote(req *RequestVoteRequest) *RequestVoteResponse {
    n.mu.Lock()
    defer n.mu.Unlock()

    response := &RequestVoteResponse{
        Term:        n.currentTerm,
        VoteGranted: false,
    }

    // Reply false if term < currentTerm
    if req.Term < n.currentTerm {
        return response
    }

    // If RPC request contains term > currentTerm, update and convert to follower
    if req.Term > n.currentTerm {
        n.currentTerm = req.Term
        n.state = Follower
        n.votedFor = ""
    }

    response.Term = n.currentTerm

    // Grant vote if:
    // 1. Haven't voted or voted for this candidate
    // 2. Candidate's log is at least as up-to-date as ours
    if (n.votedFor == "" || n.votedFor == req.CandidateID) &&
        n.isLogUpToDate(req.LastLogIndex, req.LastLogTerm) {
        n.votedFor = req.CandidateID
        response.VoteGranted = true
        n.lastHeartbeat = time.Now() // Reset election timeout
    }

    return response
}

// isLogUpToDate checks if candidate's log is at least as up-to-date as ours
func (n *RaftNode) isLogUpToDate(lastLogIndex, lastLogTerm uint64) bool {
    var myLastIndex, myLastTerm uint64
    if len(n.log) > 0 {
        myLastIndex = n.log[len(n.log)-1].Index
        myLastTerm = n.log[len(n.log)-1].Term
    }

    // Compare by term first, then by index
    if lastLogTerm != myLastTerm {
        return lastLogTerm > myLastTerm
    }
    return lastLogIndex >= myLastIndex
}

// sendRequestVote is a transport stub for sending RequestVote RPC to a peer
func (n *RaftNode) sendRequestVote(peerID string, req *RequestVoteRequest) *RequestVoteResponse {
    // In production, this makes an RPC (gRPC or HTTP) call to peerID
    return nil
}

// startElection begins a new election
func (n *RaftNode) startElection() {
    n.mu.Lock()
    n.state = Candidate
    n.currentTerm++
    n.votedFor = n.id
    currentTerm := n.currentTerm

    var lastLogIndex, lastLogTerm uint64
    if len(n.log) > 0 {
        lastLogIndex = n.log[len(n.log)-1].Index
        lastLogTerm = n.log[len(n.log)-1].Term
    }
    n.mu.Unlock()

    votes := 1 // Vote for self
    voteCh := make(chan bool, len(n.peers))

    // Request votes from all peers
    for _, peer := range n.peers {
        go func(peerID string) {
            req := &RequestVoteRequest{
                Term:         currentTerm,
                CandidateID:  n.id,
                LastLogIndex: lastLogIndex,
                LastLogTerm:  lastLogTerm,
            }

            response := n.sendRequestVote(peerID, req)
            if response != nil {
                voteCh <- response.VoteGranted

                // If response contains higher term, step down
                if response.Term > currentTerm {
                    n.mu.Lock()
                    if response.Term > n.currentTerm {
                        n.currentTerm = response.Term
                        n.state = Follower
                        n.votedFor = ""
                    }
                    n.mu.Unlock()
                }
            } else {
                voteCh <- false
            }
        }(peer)
    }

    // Count votes
    for i := 0; i < len(n.peers); i++ {
        if <-voteCh {
            votes++
        }

        // Check for majority
        if votes > (len(n.peers)+1)/2 {
            n.mu.Lock()
            if n.state == Candidate && n.currentTerm == currentTerm {
                n.becomeLeader()
            }
            n.mu.Unlock()
            return
        }
    }
}

// becomeLeader initializes leader state
func (n *RaftNode) becomeLeader() {
    n.state = Leader

    // Initialize nextIndex and matchIndex for all peers
    lastLogIndex := uint64(0)
    if len(n.log) > 0 {
        lastLogIndex = n.log[len(n.log)-1].Index
    }

    for _, peer := range n.peers {
        n.nextIndex[peer] = lastLogIndex + 1
        n.matchIndex[peer] = 0
    }

    // The main loop observes the Leader state and enters runLeader,
    // which sends the initial heartbeat and owns the heartbeat ticker.
    // Starting a second heartbeat goroutine here would double-send.
}
```

### Append Entries RPC

`AppendEntries` serves dual purpose in Raft: it carries new log entries from the leader to followers, and when sent with an empty `Entries` slice it acts as a periodic heartbeat that resets the follower's election timer. Before appending, the handler validates log consistency by checking that the entry at `PrevLogIndex` matches `PrevLogTerm`. If not, it returns conflict metadata so the leader can efficiently skip back to the right index rather than decrementing one slot at a time. Once entries are safely appended, the follower advances its `commitIndex` to the minimum of the leader's commit index and the last new entry, then applies all newly committed entries to the state machine via the `commitCh` channel.

```go
// raft/append.go
package raft

import "time"

// AppendEntriesRequest is sent by leader to replicate logs
type AppendEntriesRequest struct {
    Term         uint64     // Leader's term
    LeaderID     string     // So follower can redirect clients
    PrevLogIndex uint64     // Index of log entry immediately preceding new ones
    PrevLogTerm  uint64     // Term of prevLogIndex entry
    Entries      []LogEntry // Log entries to store (empty for heartbeat)
    LeaderCommit uint64     // Leader's commitIndex
}

// AppendEntriesResponse is the response to append entries
type AppendEntriesResponse struct {
    Term          uint64 // Current term, for leader to update itself
    Success       bool   // True if follower matched prevLogIndex/prevLogTerm
    ConflictIndex uint64 // For fast log backtracking
    ConflictTerm  uint64
}

// AppendEntries handles incoming append entries requests
func (n *RaftNode) AppendEntries(req *AppendEntriesRequest) *AppendEntriesResponse {
    n.mu.Lock()
    defer n.mu.Unlock()

    response := &AppendEntriesResponse{
        Term:    n.currentTerm,
        Success: false,
    }

    // Reply false if term < currentTerm
    if req.Term < n.currentTerm {
        return response
    }

    // Reset election timeout on valid request
    n.lastHeartbeat = time.Now()

    // If RPC request contains term >= currentTerm, recognize leader
    if req.Term > n.currentTerm {
        n.currentTerm = req.Term
        n.votedFor = ""
    }
    n.state = Follower
    response.Term = n.currentTerm

    // Check log consistency
    if req.PrevLogIndex > 0 {
        if len(n.log) < int(req.PrevLogIndex) {
            // Log is too short
            response.ConflictIndex = uint64(len(n.log))
            response.ConflictTerm = 0
            return response
        }

        if n.log[req.PrevLogIndex-1].Term != req.PrevLogTerm {
            // Term mismatch - find first index of conflicting term
            conflictTerm := n.log[req.PrevLogIndex-1].Term
            response.ConflictTerm = conflictTerm

            for i := int(req.PrevLogIndex) - 1; i >= 0; i-- {
                if n.log[i].Term != conflictTerm {
                    response.ConflictIndex = uint64(i + 2)
                    break
                }
                response.ConflictIndex = uint64(i + 1)
            }
            return response
        }
    }

    // Append new entries (handling conflicts)
    for i, entry := range req.Entries {
        idx := int(req.PrevLogIndex) + i
        if idx < len(n.log) {
            if n.log[idx].Term != entry.Term {
                // Conflict: delete entry and all that follow
                n.log = n.log[:idx]
                n.log = append(n.log, entry)
            }
            // Otherwise, entry already exists
        } else {
            n.log = append(n.log, entry)
        }
    }

    // Update commit index
    if req.LeaderCommit > n.commitIndex {
        lastNewIndex := req.PrevLogIndex + uint64(len(req.Entries))
        if req.LeaderCommit < lastNewIndex {
            n.commitIndex = req.LeaderCommit
        } else {
            n.commitIndex = lastNewIndex
        }

        // Apply committed entries
        n.applyCommitted()
    }

    response.Success = true
    return response
}

// applyCommitted nudges the applier goroutine. Callers hold n.mu, so
// this must never block: a slow commitCh consumer would otherwise
// deadlock every RPC handler. Crucially, entries are never dropped,
// the applier re-reads lastApplied and commitIndex when it wakes.
func (n *RaftNode) applyCommitted() {
    select {
    case n.applyCh <- struct{}{}:
    default: // a wakeup is already pending
    }
}

// runApplier delivers committed entries to commitCh in log order.
// It sends without holding the mutex, so backpressure from the state
// machine slows applying but never blocks Raft's RPC handlers.
func (n *RaftNode) runApplier() {
    for {
        select {
        case <-n.stopCh:
            return
        case <-n.applyCh:
            for {
                n.mu.Lock()
                if n.lastApplied >= n.commitIndex {
                    n.mu.Unlock()
                    break
                }
                n.lastApplied++
                entry := n.log[n.lastApplied-1]
                n.mu.Unlock()

                select {
                case n.commitCh <- entry:
                case <-n.stopCh:
                    return
                }
            }
        }
    }
}

// sendAppendEntries is a transport stub for sending AppendEntries RPC to a peer
func (n *RaftNode) sendAppendEntries(peerID string, req *AppendEntriesRequest) *AppendEntriesResponse {
    // In production, this makes an RPC (gRPC or HTTP) call to peerID
    return nil
}

// broadcastAppendEntries sends AppendEntries to all peers
func (n *RaftNode) broadcastAppendEntries() {
    n.mu.RLock()
    currentTerm := n.currentTerm
    commitIndex := n.commitIndex
    n.mu.RUnlock()

    for _, peer := range n.peers {
        go func(peerID string) {
            n.mu.RLock()
            nextIdx := n.nextIndex[peerID]

            var prevLogIndex, prevLogTerm uint64
            if nextIdx > 1 {
                prevLogIndex = nextIdx - 1
                prevLogTerm = n.log[prevLogIndex-1].Term
            }

            // Get entries to send
            entries := make([]LogEntry, 0)
            if int(nextIdx) <= len(n.log) {
                entries = append(entries, n.log[nextIdx-1:]...)
            }
            n.mu.RUnlock()

            req := &AppendEntriesRequest{
                Term:         currentTerm,
                LeaderID:     n.id,
                PrevLogIndex: prevLogIndex,
                PrevLogTerm:  prevLogTerm,
                Entries:      entries,
                LeaderCommit: commitIndex,
            }

            response := n.sendAppendEntries(peerID, req)
            if response == nil {
                return
            }

            n.mu.Lock()
            defer n.mu.Unlock()

            if response.Term > n.currentTerm {
                n.currentTerm = response.Term
                n.state = Follower
                n.votedFor = ""
                return
            }

            if n.state != Leader || currentTerm != n.currentTerm {
                return
            }

            if response.Success {
                // Update nextIndex and matchIndex
                n.nextIndex[peerID] = nextIdx + uint64(len(entries))
                n.matchIndex[peerID] = n.nextIndex[peerID] - 1

                // Check if we can advance commitIndex
                n.updateCommitIndex()
            } else {
                // Decrement nextIndex and retry
                if response.ConflictTerm > 0 {
                    // Find last index of ConflictTerm
                    found := false
                    for i := len(n.log) - 1; i >= 0; i-- {
                        if n.log[i].Term == response.ConflictTerm {
                            n.nextIndex[peerID] = uint64(i + 2)
                            found = true
                            break
                        }
                    }
                    if !found {
                        n.nextIndex[peerID] = response.ConflictIndex
                    }
                } else {
                    n.nextIndex[peerID] = response.ConflictIndex
                }
            }
        }(peer)
    }
}

// updateCommitIndex advances commitIndex based on matchIndex
func (n *RaftNode) updateCommitIndex() {
    // Find the highest index replicated on a majority
    for idx := n.commitIndex + 1; int(idx) <= len(n.log); idx++ {
        if n.log[idx-1].Term != n.currentTerm {
            continue // Only commit entries from current term
        }

        replicatedOn := 1 // Leader has it
        for _, peer := range n.peers {
            if n.matchIndex[peer] >= idx {
                replicatedOn++
            }
        }

        if replicatedOn > (len(n.peers)+1)/2 {
            n.commitIndex = idx
        }
    }

    n.applyCommitted()
}
```

### Main Event Loop

The main event loop dispatches control to one of three role-specific handlers, `runFollower`, `runCandidate`, or `runLeader`, based on the node's current state, re-evaluating on every iteration so a role change takes effect immediately. The follower handler calculates how much of the election timeout has already elapsed and arms a `time.After` for only the remaining duration, preventing an accidental full-timeout restart after a heartbeat arrives just before the timer fires. The leader handler uses a `time.Ticker` to broadcast `AppendEntries` at the heartbeat interval, and steps down whenever an incoming RPC contains a higher term, which is the fundamental mechanism by which a partitioned leader yields to a newly elected one.

```go
// raft/node.go
package raft

import (
    "math/rand/v2"
    "time"
)

// Start begins the Raft node operation
func (n *RaftNode) Start() {
    n.mu.Lock()
    n.running = true
    n.lastHeartbeat = time.Now()
    n.mu.Unlock()

    go n.run()
    go n.runApplier()
}

// Stop halts the Raft node
func (n *RaftNode) Stop() {
    n.mu.Lock()
    n.running = false
    n.mu.Unlock()

    close(n.stopCh)
}

// run is the main event loop
func (n *RaftNode) run() {
    for {
        select {
        case <-n.stopCh:
            return
        default:
        }

        n.mu.RLock()
        state := n.state
        n.mu.RUnlock()

        switch state {
        case Follower:
            n.runFollower()
        case Candidate:
            n.runCandidate()
        case Leader:
            n.runLeader()
        }
    }
}

// runFollower handles follower behavior
func (n *RaftNode) runFollower() {
    timeout := n.randomElectionTimeout()

    for {
        select {
        case <-n.stopCh:
            return

        case <-time.After(timeout):
            n.mu.RLock()
            elapsed := time.Since(n.lastHeartbeat)
            n.mu.RUnlock()

            if elapsed >= n.electionTimeout {
                // Start election
                go n.startElection()
                return
            }
            timeout = n.randomElectionTimeout() - elapsed
            if timeout <= 0 {
                timeout = time.Millisecond
            }

        case req := <-n.appendEntriesCh:
            response := n.AppendEntries(req)
            // Send response back (implementation depends on transport)
            _ = response

        case req := <-n.requestVoteCh:
            response := n.RequestVote(req)
            _ = response
        }
    }
}

// runCandidate handles candidate behavior
func (n *RaftNode) runCandidate() {
    timeout := n.randomElectionTimeout()

    for {
        select {
        case <-n.stopCh:
            return

        case <-time.After(timeout):
            // Election timeout - start new election
            go n.startElection()
            return

        case req := <-n.appendEntriesCh:
            response := n.AppendEntries(req)
            if response.Success {
                // Received valid AppendEntries, step down
                return
            }

        case req := <-n.requestVoteCh:
            response := n.RequestVote(req)
            if response.VoteGranted {
                // Voted for another candidate, step down
                return
            }
        }

        n.mu.RLock()
        if n.state != Candidate {
            n.mu.RUnlock()
            return
        }
        n.mu.RUnlock()
    }
}

// runLeader handles leader behavior
func (n *RaftNode) runLeader() {
    // Send initial heartbeat
    n.broadcastAppendEntries()

    heartbeat := time.NewTicker(n.heartbeatTimeout)
    defer heartbeat.Stop()

    for {
        select {
        case <-n.stopCh:
            return

        case <-heartbeat.C:
            n.broadcastAppendEntries()

        case req := <-n.appendEntriesCh:
            // A higher-term request makes the handler set state to
            // Follower under the lock. The state check below picks
            // that up, comparing response.Term to n.currentTerm here
            // without the lock would be a data race.
            n.AppendEntries(req)

        case req := <-n.requestVoteCh:
            n.RequestVote(req)
        }

        n.mu.RLock()
        if n.state != Leader {
            n.mu.RUnlock()
            return
        }
        n.mu.RUnlock()
    }
}

// Propose adds a new command to the log (leader only)
func (n *RaftNode) Propose(command any) bool {
    n.mu.Lock()
    defer n.mu.Unlock()

    if n.state != Leader {
        return false
    }

    entry := LogEntry{
        Term:    n.currentTerm,
        Index:   uint64(len(n.log) + 1),
        Command: command,
    }

    n.log = append(n.log, entry)
    n.matchIndex[n.id] = entry.Index

    return true
}

func (n *RaftNode) randomElectionTimeout() time.Duration {
    return time.Duration(150+rand.IntN(150)) * time.Millisecond
}
```

### Junior -> FAANG: Reading Raft Before You Use etcd

The most common junior mistake with distributed consensus is treating etcd or ZooKeeper as a black box. That works until something goes wrong: a leader election takes longer than expected, a watch fires unexpectedly, or a lease expires during a GC pause. When you have read the Raft paper (it is only 18 pages and written for readability), these behaviors become predictable rather than mysterious.

The key properties to understand before your first interview: Raft guarantees safety (at most one leader at any term, committed entries are never lost) but not liveness (the cluster can stall if a majority of nodes are unavailable). Safety comes from two rules enforced in `RequestVote`: a node only votes for a candidate whose log is at least as up-to-date as its own, and a node only votes once per term. Liveness comes from randomized election timeouts, which ensure nodes do not all start elections simultaneously.

For interviews, practice explaining the difference between a term and an epoch, why the randomized timeout range (150ms to 300ms in the reference implementation) matters, and what "quorum" means for a five-node cluster (three nodes). Also practice the GC pause failure mode: a leader experiences a long GC pause, its heartbeat timer lapses, followers time out and elect a new leader, then the old leader wakes up from the pause and tries to send heartbeats. The correct behavior is that the new leader's term is higher, so the old leader sees a higher term in a response and steps down.

Entry-level interview signal: you can trace through a split vote scenario (two candidates both get two votes in a five-node cluster, neither reaches three) and explain why re-randomizing the election timeout breaks the deadlock.

### Senior @ FAANG: When Not to Use Consensus and How to Run Raft in Production

Raft is correct but expensive. Every write must be replicated to a majority of nodes and durably persisted before the leader can acknowledge it. For a three-node cluster with 1ms disk latency and 0.5ms inter-node round-trip, the minimum latency per write is around 2ms. At high throughput, batching log entries per heartbeat interval (50ms default) amortizes this, but you are fundamentally bounded by your slowest majority node.

The senior question is: does your use case actually require consensus? Leader election and distributed locks do. A shared counter that is occasionally wrong does not. A rate limiter that allows 5% over the limit during a brief partition does not. Forcing Raft into every coordination problem is a classic over-engineering failure mode.

For production Raft deployments, the key operational parameters to govern are: election timeout range (wider range reduces split votes, narrower range reduces time to elect after a failure), heartbeat interval (lower means faster failure detection but more network traffic), snapshot threshold (how many log entries before the leader compacts the log into a snapshot and truncates), and disk sync policy (fsync on every log append is safe but expensive, while batching syncs improves throughput at the cost of a larger recovery window). These should be captured in a runbook, not left as code defaults.

Joint consensus (used for cluster membership changes) is the most error-prone part of Raft. The paper describes a two-phase approach where a configuration change goes through an intermediate state (`C_old,new`) before reaching the final state (`C_new`). The single-server change approach (only add or remove one node at a time) is simpler and safe, but it means adding three nodes to a six-node cluster requires three sequential membership changes, each requiring a round of consensus. etcd's learner role is the production answer: a new node joins as a non-voting learner, replicates the log until it catches up, and then gets promoted to voter in a single membership change. This eliminates the availability risk of adding a slow node directly as a voter.

Bar-raiser signal: you know that Raft's `currentTerm` and `votedFor` must be durably persisted before responding to any RPC (a node that loses these on crash and recovers with stale values can corrupt the cluster), and you can explain why the Go implementation above would need a write-ahead log or BoltDB/badger backend to be production-safe.

---
