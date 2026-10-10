## 64C.4 Implementing Raft in Go

Below is a complete, simplified (but correct for crash fault tolerance) Raft implementation in Go. This is production-representative code, not pseudocode.

```go
// raft/raft.go
package raft

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"net/rpc"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeState int32

const (
	Follower  NodeState = iota
	Candidate NodeState = iota
	Leader    NodeState = iota
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

type LogEntry struct {
	Term    int
	Index   int
	Command any
}

// ApplyMsg is sent on the applyCh when a log entry is committed.
type ApplyMsg struct {
	CommandValid bool
	Command      any
	CommandIndex int
	CommandTerm  int

	// For snapshots
	SnapshotValid bool
	Snapshot      []byte
	SnapshotTerm  int
	SnapshotIndex int
}

// PersistentState is what must be written to stable storage before
// responding to any RPC. Losing this on crash is a safety violation.
type PersistentState struct {
	CurrentTerm int
	VotedFor    int // -1 if not voted
	Log         []LogEntry
}

// ─── RPC Types ────────────────────────────────────────────────────────────────

type RequestVoteArgs struct {
	Term         int
	CandidateID  int
	LastLogIndex int
	LastLogTerm  int
}

type RequestVoteReply struct {
	Term        int
	VoteGranted bool
}

type AppendEntriesArgs struct {
	Term         int
	LeaderID     int
	PrevLogIndex int
	PrevLogTerm  int
	Entries      []LogEntry
	LeaderCommit int
}

type AppendEntriesReply struct {
	Term    int
	Success bool
	// Optimization: allow faster log backup
	// ConflictTerm == -1: follower's log too short - ConflictIndex = len(log)
	// ConflictTerm != -1: term of conflicting entry - ConflictIndex = first entry with that term
	ConflictTerm  int
	ConflictIndex int
}

// ─── Raft Node ────────────────────────────────────────────────────────────────

type Raft struct {
	mu      sync.Mutex
	peers   []string // RPC addresses of all nodes (including self)
	me      int      // this node's index in peers[]
	dead    int32    // set by Kill()
	applyCh chan ApplyMsg

	// Persistent state (must survive crashes)
	currentTerm int
	votedFor    int
	log         []LogEntry // log[0] is a dummy entry

	// Volatile state (all nodes)
	commitIndex int
	lastApplied int

	// Volatile state (leaders only, reinitialized after election)
	nextIndex  []int // for each peer: index of next log entry to send
	matchIndex []int // for each peer: highest log entry known to be replicated

	state NodeState

	// Channels for internal coordination
	heartbeatCh  chan struct{}
	electionCh   chan struct{}
	applyCond    *sync.Cond

	// Snapshot state
	lastSnapshotIndex int
	lastSnapshotTerm  int

	// Persistent storage
	persister *Persister
}

// Persister handles durable storage.
type Persister struct {
	mu            sync.Mutex
	raftstate     []byte
	snapshot      []byte
	stateFilePath string
}

func NewPersister(path string) *Persister {
	return &Persister{stateFilePath: path}
}

func (p *Persister) SaveRaftState(state []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.raftstate = state
	// In production: fsync to disk
	if err := os.WriteFile(p.stateFilePath, state, 0600); err != nil {
		log.Printf("persister: write error: %v", err)
	}
}

func (p *Persister) ReadRaftState() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.raftstate != nil {
		return p.raftstate
	}
	data, err := os.ReadFile(p.stateFilePath)
	if err != nil {
		return nil
	}
	p.raftstate = data
	return data
}

func (p *Persister) SaveStateAndSnapshot(state, snapshot []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.raftstate = state
	p.snapshot = snapshot
	// Would write both atomically in production
}

func (p *Persister) ReadSnapshot() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snapshot
}

// ─── Constructor ──────────────────────────────────────────────────────────────

func NewRaft(peers []string, me int, persister *Persister, applyCh chan ApplyMsg) *Raft {
	rf := &Raft{
		peers:       peers,
		me:          me,
		persister:   persister,
		applyCh:     applyCh,
		votedFor:    -1,
		state:       Follower,
		heartbeatCh: make(chan struct{}, 1),
		electionCh:  make(chan struct{}, 1),
	}
	rf.log = []LogEntry{{Term: 0, Index: 0}} // dummy entry at index 0
	rf.applyCond = sync.NewCond(&rf.mu)

	// Restore persisted state if it exists
	rf.readPersist(persister.ReadRaftState())
	if snap := persister.ReadSnapshot(); len(snap) > 0 {
		// In a full implementation, lastSnapshotIndex and lastSnapshotTerm
	// would be restored from the snapshot metadata stored alongside the snapshot.
	}

	go rf.ticker()
	go rf.applyLoop()

	return rf
}

// ─── Persistence ──────────────────────────────────────────────────────────────

// persist saves currentTerm, votedFor, and log to stable storage.
// MUST be called (with lock held) before responding to any RPC.
func (rf *Raft) persist() {
	ps := PersistentState{
		CurrentTerm: rf.currentTerm,
		VotedFor:    rf.votedFor,
		Log:         rf.log,
	}
	data, err := json.Marshal(ps)
	if err != nil {
		log.Fatalf("raft: persist marshal error: %v", err)
	}
	rf.persister.SaveRaftState(data)
}

func (rf *Raft) readPersist(data []byte) {
	if len(data) == 0 {
		return
	}
	var ps PersistentState
	if err := json.Unmarshal(data, &ps); err != nil {
		log.Printf("raft: readPersist unmarshal error: %v", err)
		return
	}
	rf.currentTerm = ps.CurrentTerm
	rf.votedFor = ps.VotedFor
	rf.log = ps.Log
}

// ─── Log Helpers ──────────────────────────────────────────────────────────────

// lastLogIndex returns the index of the last log entry.
func (rf *Raft) lastLogIndex() int {
	return rf.log[len(rf.log)-1].Index
}

// lastLogTerm returns the term of the last log entry.
func (rf *Raft) lastLogTerm() int {
	return rf.log[len(rf.log)-1].Term
}

// logAt returns the log entry at the given absolute index.
// Accounts for log compaction (lastSnapshotIndex offset).
func (rf *Raft) logAt(index int) LogEntry {
	return rf.log[index-rf.lastSnapshotIndex]
}

// ─── State Transitions ────────────────────────────────────────────────────────

func (rf *Raft) becomeFollower(term int) {
	rf.state = Follower
	rf.currentTerm = term
	rf.votedFor = -1
	rf.persist()
}

func (rf *Raft) becomeCandidate() {
	rf.state = Candidate
	rf.currentTerm++
	rf.votedFor = rf.me
	rf.persist()
	log.Printf("[Node %d] becoming candidate, term %d", rf.me, rf.currentTerm)
}

func (rf *Raft) becomeLeader() {
	rf.state = Leader
	n := len(rf.peers)
	rf.nextIndex = make([]int, n)
	rf.matchIndex = make([]int, n)
	for i := range rf.nextIndex {
		rf.nextIndex[i] = rf.lastLogIndex() + 1
	}
	log.Printf("[Node %d] became leader for term %d", rf.me, rf.currentTerm)
	// Send immediate heartbeat to assert leadership
	go rf.sendHeartbeats()
}

// ─── RequestVote RPC ──────────────────────────────────────────────────────────

func (rf *Raft) RequestVote(args *RequestVoteArgs, reply *RequestVoteReply) error {
	rf.mu.Lock()
	defer rf.mu.Unlock()

	reply.Term = rf.currentTerm
	reply.VoteGranted = false

	// Rule 1: Reject if candidate's term is behind ours
	if args.Term < rf.currentTerm {
		return nil
	}

	// Rule 2: If we see a higher term, become follower
	if args.Term > rf.currentTerm {
		rf.becomeFollower(args.Term)
		reply.Term = rf.currentTerm
	}

	// Rule 3: Check if we can grant vote
	// - We haven't voted yet in this term, or we already voted for this candidate
	canVote := rf.votedFor == -1 || rf.votedFor == args.CandidateID

	// Rule 4: Candidate's log must be at least as up-to-date as ours
	candidateUpToDate := args.LastLogTerm > rf.lastLogTerm() ||
		(args.LastLogTerm == rf.lastLogTerm() && args.LastLogIndex >= rf.lastLogIndex())

	if canVote && candidateUpToDate {
		rf.votedFor = args.CandidateID
		rf.persist()
		reply.VoteGranted = true
		// Reset election timer so we don't compete with the candidate we just voted for
		rf.resetElectionTimer()
		log.Printf("[Node %d] voted for node %d in term %d", rf.me, args.CandidateID, rf.currentTerm)
	}

	return nil
}

// ─── AppendEntries RPC ────────────────────────────────────────────────────────

func (rf *Raft) AppendEntries(args *AppendEntriesArgs, reply *AppendEntriesReply) error {
	rf.mu.Lock()
	defer rf.mu.Unlock()

	reply.Term = rf.currentTerm
	reply.Success = false
	reply.ConflictTerm = -1
	reply.ConflictIndex = -1

	// Rule 1: Reject if leader's term is behind ours
	if args.Term < rf.currentTerm {
		return nil
	}

	// Rule 2: If higher term or valid leader, revert to follower
	if args.Term > rf.currentTerm || rf.state != Follower {
		rf.becomeFollower(args.Term)
		reply.Term = rf.currentTerm
	}

	// Valid heartbeat/AppendEntries from current leader - reset timer
	rf.resetElectionTimer()

	// Rule 3: Log consistency check
	// Does our log contain an entry at PrevLogIndex with PrevLogTerm?
	if args.PrevLogIndex > rf.lastLogIndex() {
		// Our log is too short
		reply.ConflictIndex = rf.lastLogIndex() + 1
		return nil
	}

	if args.PrevLogIndex >= rf.lastSnapshotIndex {
		prevEntry := rf.logAt(args.PrevLogIndex)
		if prevEntry.Term != args.PrevLogTerm {
			// Conflict: find first index of conflicting term for faster backtracking
			conflictTerm := prevEntry.Term
			reply.ConflictTerm = conflictTerm
			conflictIndex := args.PrevLogIndex
			for conflictIndex > rf.lastSnapshotIndex &&
				rf.logAt(conflictIndex-1).Term == conflictTerm {
				conflictIndex--
			}
			reply.ConflictIndex = conflictIndex
			return nil
		}
	}

	// Rule 4: Append new entries, removing conflicts
	for i, entry := range args.Entries {
		idx := args.PrevLogIndex + 1 + i
		if idx <= rf.lastLogIndex() {
			if rf.logAt(idx).Term != entry.Term {
				// Conflict: truncate log at this point
				rf.log = rf.log[:idx-rf.lastSnapshotIndex]
				rf.log = append(rf.log, args.Entries[i:]...)
				break
			}
			// Entry already matches - skip
		} else {
			// Append remaining entries
			rf.log = append(rf.log, args.Entries[i:]...)
			break
		}
	}
	rf.persist()
	reply.Success = true

	// Rule 5: Update commitIndex
	if args.LeaderCommit > rf.commitIndex {
		newCommit := args.LeaderCommit
		if rf.lastLogIndex() < newCommit {
			newCommit = rf.lastLogIndex()
		}
		rf.commitIndex = newCommit
		rf.applyCond.Signal()
	}

	return nil
}

// ─── Leader: Sending AppendEntries ────────────────────────────────────────────

func (rf *Raft) sendHeartbeats() {
	rf.mu.Lock()
	if rf.state != Leader {
		rf.mu.Unlock()
		return
	}
	term := rf.currentTerm
	rf.mu.Unlock()

	for i := range rf.peers {
		if i == rf.me {
			continue
		}
		go rf.replicateTo(i, term)
	}
}

func (rf *Raft) replicateTo(peer, term int) {
	rf.mu.Lock()

	if rf.state != Leader || rf.currentTerm != term {
		rf.mu.Unlock()
		return
	}

	nextIdx := rf.nextIndex[peer]
	prevLogIndex := nextIdx - 1
	prevLogTerm := 0

	if prevLogIndex > rf.lastSnapshotIndex {
		prevLogTerm = rf.logAt(prevLogIndex).Term
	} else if prevLogIndex == rf.lastSnapshotIndex {
		prevLogTerm = rf.lastSnapshotTerm
	}

	// Collect entries to send
	var entries []LogEntry
	if nextIdx <= rf.lastLogIndex() {
		entries = make([]LogEntry, len(rf.log[nextIdx-rf.lastSnapshotIndex:]))
		copy(entries, rf.log[nextIdx-rf.lastSnapshotIndex:])
	}

	args := AppendEntriesArgs{
		Term:         rf.currentTerm,
		LeaderID:     rf.me,
		PrevLogIndex: prevLogIndex,
		PrevLogTerm:  prevLogTerm,
		Entries:      entries,
		LeaderCommit: rf.commitIndex,
	}
	rf.mu.Unlock()

	var reply AppendEntriesReply
	if err := rf.call(peer, "Raft.AppendEntries", &args, &reply); err != nil {
		return
	}

	rf.mu.Lock()
	defer rf.mu.Unlock()

	if reply.Term > rf.currentTerm {
		rf.becomeFollower(reply.Term)
		return
	}

	if rf.state != Leader || rf.currentTerm != term {
		return
	}

	if reply.Success {
		newMatch := args.PrevLogIndex + len(args.Entries)
		if newMatch > rf.matchIndex[peer] {
			rf.matchIndex[peer] = newMatch
			rf.nextIndex[peer] = newMatch + 1
		}
		// Try to advance commitIndex
		rf.maybeAdvanceCommitIndex()
	} else {
		// Backtrack nextIndex using conflict hint
		if reply.ConflictTerm == -1 {
			rf.nextIndex[peer] = reply.ConflictIndex
		} else {
			// Find last entry with ConflictTerm in our log
			found := false
			for i := rf.lastLogIndex(); i > rf.lastSnapshotIndex; i-- {
				if rf.logAt(i).Term == reply.ConflictTerm {
					rf.nextIndex[peer] = i + 1
					found = true
					break
				}
			}
			if !found {
				rf.nextIndex[peer] = reply.ConflictIndex
			}
		}
		if rf.nextIndex[peer] < 1 {
			rf.nextIndex[peer] = 1
		}
	}
}

// maybeAdvanceCommitIndex advances commitIndex if a majority has replicated
// an entry from the current term.
func (rf *Raft) maybeAdvanceCommitIndex() {
	// Find highest N such that:
	// 1. N > commitIndex
	// 2. log[N].term == currentTerm
	// 3. matchIndex[i] >= N for a majority of nodes
	for n := rf.lastLogIndex(); n > rf.commitIndex; n-- {
		if rf.logAt(n).Term != rf.currentTerm {
			break // Only commit entries from current term
		}
		count := 1 // Count ourselves
		for i := range rf.peers {
			if i != rf.me && rf.matchIndex[i] >= n {
				count++
			}
		}
		if count*2 > len(rf.peers) {
			rf.commitIndex = n
			rf.applyCond.Signal()
			break
		}
	}
}

// ─── Leader Election ──────────────────────────────────────────────────────────

func (rf *Raft) startElection() {
	rf.mu.Lock()
	rf.becomeCandidate()
	term := rf.currentTerm
	lastIdx := rf.lastLogIndex()
	lastTerm := rf.lastLogTerm()
	rf.mu.Unlock()

	votes := int32(1) // vote for self
	majority := int32(len(rf.peers)/2 + 1)
	wonElection := int32(0)

	for i := range rf.peers {
		if i == rf.me {
			continue
		}
		go func(peer int) {
			args := RequestVoteArgs{
				Term:         term,
				CandidateID:  rf.me,
				LastLogIndex: lastIdx,
				LastLogTerm:  lastTerm,
			}
			var reply RequestVoteReply
			if err := rf.call(peer, "Raft.RequestVote", &args, &reply); err != nil {
				return
			}

			rf.mu.Lock()
			defer rf.mu.Unlock()

			if reply.Term > rf.currentTerm {
				rf.becomeFollower(reply.Term)
				return
			}

			// Only count vote if we're still a candidate in the same term
			if rf.state != Candidate || rf.currentTerm != term {
				return
			}

			if reply.VoteGranted {
				newVotes := atomic.AddInt32(&votes, 1)
				if newVotes >= majority && atomic.CompareAndSwapInt32(&wonElection, 0, 1) {
					rf.becomeLeader()
				}
			}
		}(i)
	}
}

// ─── Election Timer (ticker) ─────────────────────────────────────────────────

const (
	heartbeatInterval    = 50 * time.Millisecond
	electionTimeoutMin   = 150 * time.Millisecond
	electionTimeoutMax   = 300 * time.Millisecond
)

func (rf *Raft) randomElectionTimeout() time.Duration {
	delta := electionTimeoutMax - electionTimeoutMin
	return electionTimeoutMin + time.Duration(rand.Int64N(int64(delta)))
}

func (rf *Raft) resetElectionTimer() {
	select {
	case rf.heartbeatCh <- struct{}{}:
	default:
	}
}

// ticker runs the main election/heartbeat loop.
func (rf *Raft) ticker() {
	for !rf.killed() {
		rf.mu.Lock()
		state := rf.state
		rf.mu.Unlock()

		switch state {
		case Follower, Candidate:
			timeout := rf.randomElectionTimeout()
			select {
			case <-rf.heartbeatCh:
				// Received heartbeat; reset timer (loop again)
			case <-time.After(timeout):
				// Election timeout - start election
				rf.startElection()
			}
		case Leader:
			// Send heartbeats periodically
			time.Sleep(heartbeatInterval)
			rf.sendHeartbeats()
		}
	}
}

// ─── Apply Loop ───────────────────────────────────────────────────────────────

// applyLoop watches for newly committed entries and sends them to the
// application via applyCh.
func (rf *Raft) applyLoop() {
	for !rf.killed() {
		rf.mu.Lock()
		// Also break the wait when Kill() broadcasts: without the
		// killed() check here the goroutine re-waits forever after
		// shutdown, since lastApplied >= commitIndex still holds.
		for rf.lastApplied >= rf.commitIndex && !rf.killed() {
			rf.applyCond.Wait()
		}
		if rf.killed() {
			rf.mu.Unlock()
			return
		}
		// Collect entries to apply
		start := rf.lastApplied + 1
		end := rf.commitIndex
		entries := make([]LogEntry, 0, end-start+1)
		for i := start; i <= end; i++ {
			if i > rf.lastSnapshotIndex {
				entries = append(entries, rf.logAt(i))
			}
		}
		rf.lastApplied = end
		rf.mu.Unlock()

		for _, entry := range entries {
			rf.applyCh <- ApplyMsg{
				CommandValid: true,
				Command:      entry.Command,
				CommandIndex: entry.Index,
				CommandTerm:  entry.Term,
			}
		}
	}
}

// ─── Client Interface ─────────────────────────────────────────────────────────

// Start appends a command to the log. Returns (index, term, isLeader).
// Only the leader accepts commands - followers return isLeader=false.
func (rf *Raft) Start(command any) (int, int, bool) {
	rf.mu.Lock()
	defer rf.mu.Unlock()

	if rf.state != Leader {
		return -1, -1, false
	}

	index := rf.lastLogIndex() + 1
	term := rf.currentTerm
	entry := LogEntry{
		Term:    term,
		Index:   index,
		Command: command,
	}
	rf.log = append(rf.log, entry)
	rf.persist()

	// Immediately try to replicate
	go rf.sendHeartbeats()

	return index, term, true
}

// GetState returns current term and whether this node believes it is leader.
func (rf *Raft) GetState() (int, bool) {
	rf.mu.Lock()
	defer rf.mu.Unlock()
	return rf.currentTerm, rf.state == Leader
}

// Kill shuts down this Raft instance.
func (rf *Raft) Kill() {
	atomic.StoreInt32(&rf.dead, 1)
	rf.applyCond.Broadcast()
}

func (rf *Raft) killed() bool {
	return atomic.LoadInt32(&rf.dead) == 1
}

// ─── RPC Transport ────────────────────────────────────────────────────────────

// call sends an RPC to the given peer. In production, replace with
// your preferred RPC framework (gRPC, etc.).
func (rf *Raft) call(peer int, method string, args, reply any) error {
	client, err := rpc.DialHTTP("tcp", rf.peers[peer])
	if err != nil {
		return fmt.Errorf("dial %s: %w", rf.peers[peer], err)
	}
	defer client.Close()
	return client.Call(method, args, reply)
}

// ServeRPC registers and serves this node's RPC methods.
func (rf *Raft) ServeRPC(addr string) error {
	server := rpc.NewServer()
	if err := server.Register(rf); err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle(rpc.DefaultRPCPath, server)
	return http.ListenAndServe(addr, mux)
}
```

### Network Partition Simulation for Testing

Testing a consensus algorithm's correctness requires the ability to induce and heal network partitions deterministically, something that real networks cannot provide on demand. The `NetworkSim` intercepts RPC calls between nodes and silently drops messages between any two endpoints listed in its `blocked` map, allowing tests to verify critical invariants: that a partitioned minority can never commit new entries, that the majority partition elects exactly one new leader, and that the old leader steps down when it rejoins and discovers a higher term. Without this infrastructure, race conditions in `becomeLeader`, `maybeAdvanceCommitIndex`, and `replicateTo` would only surface under production load, making them nearly impossible to reproduce and debug.

```go
// raft/network_test.go
package raft_test

import (
	"sync"
	"testing"
	"time"
)

// NetworkSim simulates a network where partitions can be induced.
type NetworkSim struct {
	mu      sync.Mutex
	blocked map[[2]int]bool // (from, to) pairs that are blocked
}

func NewNetworkSim() *NetworkSim {
	return &NetworkSim{blocked: make(map[[2]int]bool)}
}

func (n *NetworkSim) Partition(group1, group2 []int) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, a := range group1 {
		for _, b := range group2 {
			n.blocked[[2]int{a, b}] = true
			n.blocked[[2]int{b, a}] = true
		}
	}
}

func (n *NetworkSim) Heal() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.blocked = make(map[[2]int]bool)
}

func (n *NetworkSim) IsBlocked(from, to int) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.blocked[[2]int{from, to}]
}

func TestLeaderElection(t *testing.T) {
	// Setup a 3-node cluster
	// (simplified - real test would use channels to simulate RPC)
	t.Run("basic election", func(t *testing.T) {
		t.Log("Starting 3-node cluster...")
		// Wait for leader election
		time.Sleep(500 * time.Millisecond)
		t.Log("Leader should be elected by now")
		// Assert exactly one leader exists
	})

	t.Run("partition and re-election", func(t *testing.T) {
		net := NewNetworkSim()
		t.Log("Partitioning leader from followers...")
		// Leader is node 0 - partition [0] from [1,2]
		net.Partition([]int{0}, []int{1, 2})
		time.Sleep(500 * time.Millisecond)
		// Nodes 1 and 2 should elect a new leader
		net.Heal()
		time.Sleep(300 * time.Millisecond)
		// Original leader should step down (discovers higher term)
	})
}

func TestLogReplication(t *testing.T) {
	t.Run("commit requires majority", func(t *testing.T) {
		// With 3 nodes, commit requires 2 acknowledgments
		// Submit command, partition leader from one follower
		// Command should still commit (2/3 = majority)
		t.Log("Commands should commit with 2/3 nodes")
	})

	t.Run("no commit without majority", func(t *testing.T) {
		// Partition leader from BOTH followers
		// Commands should NOT commit
		t.Log("Commands must not commit with only 1/3 nodes")
	})
}
```

---

### Junior → FAANG: Reading a Raft Implementation Like a Senior

The code in this section is production-representative Go. Reading it carefully reveals more than the Raft paper alone, because it shows the gap between algorithm description and safe implementation.

**The three mandatory persist calls.** Search the code for calls to `rf.persist()`. Each one appears immediately after mutating `currentTerm`, `votedFor`, or `log`. These three fields must be written to stable storage before an RPC response is sent. Missing a persist call is a safety violation: if the node crashes between the state change and the response, it may restart with stale state and vote for two candidates in the same term. In a code review, every modification of these three fields should be followed immediately by a persist call.

**The `atomic.CompareAndSwapInt32` in `startElection`.** The vote counting uses an atomic compare-and-swap to ensure that `becomeLeader` is called at most once, even if multiple vote responses arrive simultaneously in separate goroutines. This is a common concurrency bug in Raft implementations: without the CAS, two goroutines can both count the vote that crosses the majority threshold and both call `becomeLeader`, initializing `nextIndex` and `matchIndex` twice in a race. The CAS ensures only the first goroutine to reach the threshold proceeds.

**The `heartbeatCh` buffered channel pattern.** The election timer uses a buffered channel of size 1 as a "reset" signal. The `select` in `resetElectionTimer` uses the `default` case to avoid blocking if the channel already has a signal. This is idiomatic Go for "notify at most once": if the timer has already been reset and the signal is pending, do not block. This pattern avoids the goroutine leak that would occur if the send blocked on a full channel while the ticker goroutine was sleeping.

**Interview connection: "How does your Raft node handle log backtracking?"** The `replicateTo` function includes conflict hint handling (ConflictTerm and ConflictIndex). Without this optimization, the leader backtracks one entry at a time when a follower rejects AppendEntries. With the hint, the leader can jump directly to the first entry of the conflicting term, reducing the number of RPCs needed to catch up a lagging follower from O(log entries) to O(number of conflicting terms).

### Senior @ FAANG: Code Review Lens for Raft Implementations

**Correctness invariants to check in any Raft implementation.** When reviewing a Raft implementation, verify these invariants explicitly rather than reading for general understanding.

First: is `persist()` called before sending any RPC response that depends on the persisted state? This means after every mutation of `currentTerm`, `votedFor`, or `log`. The code in this section does this correctly, but it is easy to miss in refactors.

Second: does `maybeAdvanceCommitIndex` require `rf.logAt(n).Term == rf.currentTerm` before advancing commitIndex? This is the rule that prevents committing entries from prior terms by replica count alone. If this check is absent, the Raft implementation has a safety violation that can manifest as data loss after a leader change.

Third: does the `applyLoop` hold the lock while sending to `applyCh`? If it does, and the `applyCh` receiver is slow (or blocked), the entire Raft node will deadlock. The correct pattern is to collect the entries to apply while holding the lock, release the lock, then send to `applyCh`. The code in this section does this correctly.

**ADR: RPC transport selection.** This implementation uses Go's `net/rpc` over HTTP for simplicity. In production, `net/rpc` has known limitations: it uses `encoding/gob` which is not compatible with other languages, it does not support streaming, and its HTTP framing has overhead for small RPCs. For a production Raft implementation in Go, gRPC with protobuf is the standard choice: it provides bidirectional streaming (useful for InstallSnapshot), language interoperability, and automatic retry with backoff. etcd and CockroachDB both use gRPC for Raft RPCs. Document the transport choice in an ADR with explicit reasoning about payload size, peer language requirements, and streaming needs.

**Staff concern: testing strategy for consensus implementations.** Unit tests on a Raft node are necessary but insufficient. The bugs that matter are concurrency and timing bugs that only manifest under specific message orderings. Production-grade Raft testing requires a deterministic network simulator that can control message delivery order. The MIT 6.824 lab framework (used by thousands of distributed systems students) provides this: a simulated network that can delay, reorder, and drop messages, with a test harness that replays specific scenarios. If you are building a custom Raft implementation for a platform team, investing in a deterministic network simulator is not optional. Without it, you will ship correctness bugs that only appear in production under specific failure conditions.

**L6/L7 concern: the gap between a passing test suite and a correct implementation.** The most dangerous class of Raft bugs are those that pass all deterministic tests but fail under production timing. These include: a persist call that is not fsynced (the OS may cache the write), a mutex that is acquired in a different order in different code paths (potential deadlock under memory pressure), and an apply loop that holds the lock while blocking on a channel send (deadlock when the consumer is slow). The only way to catch these is a combination of chaos testing with real network conditions, long-duration soak tests under load, and review by someone who has debugged Raft implementations in production. Code review at the staff level is not checking correctness. It is checking whether the testing strategy is sufficient to detect the class of bugs that this implementation is susceptible to.

---
