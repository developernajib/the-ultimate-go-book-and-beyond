## 64C.3 Raft - Understandable Consensus

### Why Raft Was Created

Diego Ongaro and John Ousterhout created Raft specifically to be more understandable than Paxos. Their 2014 paper, "In Search of an Understandable Consensus Algorithm," describes Raft with the explicit design goal of making every aspect of the algorithm straightforward to reason about.

The key insight: Paxos handles all parts of consensus simultaneously in a tightly coupled way, making it hard to reason about each part. Raft decomposes consensus into three **relatively independent** subproblems:

1. **Leader election** - one server is chosen as leader
2. **Log replication** - the leader accepts log entries, replicates them to followers
3. **Safety** - a set of invariants that ensure correctness

### Server States

Every Raft node is in exactly one of three states:

```
                  ┌──────────────┐
     starts up    │              │   discovers higher term
   ──────────────→│   FOLLOWER   │←─────────────────────────────
                  │              │
                  └──────┬───────┘
                         │ election timeout elapses
                         │ (no leader heartbeat received)
                         ↓
                  ┌──────────────┐
                  │              │   discovers higher term /
                  │  CANDIDATE   │←── discovers current leader
                  │              │
                  └──────┬───────┘
                         │ receives votes from majority
                         ↓
                  ┌──────────────┐
                  │              │
                  │    LEADER    │
                  │              │
                  └──────────────┘
```

### Terms and Term Numbers

Raft divides time into **terms**, numbered with consecutive integers. Each term begins with an election. A term number serves as a logical clock - it helps nodes detect stale leaders and stale messages.

```
 Time ──────────────────────────────────────────────────────→
 Term:  [ Term 1 ]   [ Term 2 ]     [  Term 3              ]
        [Election]   [Election]     [Election][Normal ops...]
         ↑ Leader 1   ↑ Fails       ↑ Leader 3
         elected      election       elected
                      (split vote,
                       no winner)
```

**Key rule:** If a node receives any message with a term number greater than its own current term, it immediately updates its term and converts to follower. This ensures stale leaders immediately step down.

### Leader Election Protocol

**Election Timeout:** Each follower maintains an election timer. If no heartbeat (AppendEntries RPC with empty entries) is received within the election timeout, the follower assumes the leader has failed and starts an election.

The election timeout is randomized (typically 150ms-300ms in the Raft paper). Randomization breaks symmetry - it is unlikely that two nodes will both time out at the exact same millisecond.

**Election Process:**

```
Step 1: Follower becomes Candidate
  - Increment currentTerm
  - Vote for self
  - Reset election timer
  - Send RequestVote RPC to all other nodes

Step 2: Vote Granting (each node)
  Grant vote if ALL of:
  1. candidate's term >= receiver's current term
  2. receiver has not yet voted in this term (or voted for this candidate)
  3. candidate's log is at least as up-to-date as receiver's log
     (Log up-to-date: higher last log term wins; if equal, longer log wins)

Step 3: Winning the election
  - Candidate receives votes from majority of cluster
  - Becomes leader
  - Immediately sends heartbeats to all nodes to establish authority

Step 4: Split vote / timeout
  - No candidate reaches majority (split votes possible)
  - Election timeout fires again
  - Increment term, start new election
  - Randomized timeout makes repeated splits unlikely
```

**RequestVote RPC:**

```go
type RequestVoteArgs struct {
    Term         int // candidate's term
    CandidateID  int // candidate requesting vote
    LastLogIndex int // index of candidate's last log entry
    LastLogTerm  int // term of candidate's last log entry
}

type RequestVoteReply struct {
    Term        int  // currentTerm, for candidate to update itself
    VoteGranted bool // true means candidate received vote
}
```

**Election Safety Guarantee:** Raft guarantees that at most one leader can be elected in any given term. This follows from the quorum intersection property: to win an election, a candidate must receive votes from a majority of nodes. Two different candidates cannot both receive votes from a majority in the same term (any two majorities share at least one node, which can only vote once per term).

### Log Replication

Once elected, the leader handles all client requests. Each request is appended to the leader's log as a new entry, then replicated to followers.

```
Leader log:    [1:set x=1][2:set y=2][3:del z][4:set x=9]
                    ↕           ↕          ↕         ↕
Follower A:    [1:set x=1][2:set y=2][3:del z][4:set x=9]
Follower B:    [1:set x=1][2:set y=2][3:del z]
                                                      ↑
                                                 (replicating)
```

**AppendEntries RPC:**

```go
type AppendEntriesArgs struct {
    Term         int        // leader's term
    LeaderID     int        // so follower can redirect clients
    PrevLogIndex int        // index of log entry immediately preceding new ones
    PrevLogTerm  int        // term of PrevLogIndex entry
    Entries      []LogEntry // log entries to store (empty for heartbeat)
    LeaderCommit int        // leader's commitIndex
}

type AppendEntriesReply struct {
    Term    int  // currentTerm, for leader to update itself
    Success bool // true if follower contained entry matching PrevLogIndex/PrevLogTerm
    // Optimization: conflict info for faster log backtracking
    ConflictTerm  int
    ConflictIndex int
}
```

**Commitment Rules:**

A log entry is **committed** once the leader has replicated it to a majority of nodes. Once committed, it will never be overridden. The leader then notifies followers of the new commitIndex via subsequent AppendEntries RPCs, and followers apply committed entries to their state machines.

```
Commitment process:
  1. Client sends command to leader
  2. Leader appends entry to local log: (index, term, command)
  3. Leader sends AppendEntries to all followers in parallel
  4. Followers append entry and reply success
  5. Once leader hears success from majority → entry is committed
  6. Leader applies entry to state machine, responds to client
  7. Leader piggybacks commitIndex in next AppendEntries
  8. Followers advance their commitIndex, apply to state machine
```

**Log Matching Property:** If two logs contain an entry with the same index and term, then:
1. The entries are identical (same command)
2. All preceding entries are identical

This is maintained by the **consistency check** in AppendEntries: the leader includes `(PrevLogIndex, PrevLogTerm)` with each AppendEntries. A follower only appends entries if its log contains an entry at PrevLogIndex with term PrevLogTerm. If not, it rejects the RPC and the leader backs up its nextIndex for that follower.

### Safety

**Election Restriction:** Raft ensures that the elected leader always has all committed entries. This is enforced in vote granting: a voter refuses to vote for a candidate whose log is less up-to-date than its own. "More up-to-date" means:
- Higher last log term wins
- If last log terms are equal, longer log wins

This means a candidate cannot win an election unless it has all entries that were committed before the election - because committed entries are on a majority of nodes, and the candidate must get a majority of votes, so at least one node with the committed entry must have voted for it and only would have if the candidate's log was at least as up-to-date.

**Only Commit Entries From Current Term:** A leader cannot directly commit a log entry from a previous term by counting replicas - it can only commit log entries from its current term. Entries from previous terms are committed indirectly when a current-term entry is committed (due to the log matching property).

This subtle rule prevents a class of safety violations that can arise during leader changes.

### Cluster Membership Changes (Joint Consensus)

Adding or removing servers from a Raft cluster is dangerous if done naively - you can end up with two disjoint majorities that each elect a leader.

Raft uses **joint consensus**: the cluster transitions through a joint configuration (C_old,new) that requires majorities from both the old and new configurations before committing the new configuration alone. This ensures there is never a point where two independent majorities can exist.

### Log Compaction and Snapshots

An unbounded log is impractical. Raft handles log growth through **snapshots**: the state machine periodically writes its entire current state to disk (a snapshot), along with the index and term of the last log entry included. All log entries up to that point can be discarded.

When a follower is far behind (or is a new node), the leader sends it the entire snapshot via an InstallSnapshot RPC rather than trying to replay potentially thousands of log entries.

### Junior → FAANG: Raft State Machines as Interview Currency

Raft is the most commonly probed consensus algorithm in FAANG system design interviews because it is the most widely deployed (etcd, CockroachDB, Consul, Vault) and because the Raft paper was explicitly designed to be teachable. Interviewers at L4/L5 expect you to walk through the state diagram from memory.

**Practice the state transitions out loud.** Start: "A follower receives no heartbeat for an election timeout of 150-300ms. It increments its term, votes for itself, and sends RequestVote to all peers. If it receives votes from a majority, it becomes leader and immediately sends heartbeats. If it receives a message from a valid leader with a term greater than or equal to its own, it reverts to follower. If the election times out again, it increments term and retries." Practice this until you can say it without looking at notes.

**The commitment rule is the most error-prone part.** A leader can only directly commit entries from the current term. Entries from prior terms are committed indirectly when a current-term entry is committed above them (by the Log Matching Property). If you forget this rule in an interview, your Raft answer will have a correctness hole that a senior interviewer will find immediately.

**Joint consensus is an advanced topic.** You will rarely be asked for the full joint consensus protocol at L4/L5. At L5/L6, you should be able to explain why naive membership changes are unsafe (two independent majorities can coexist during the transition) and that Raft's solution is to route through a joint configuration that requires majority from both old and new members.

**Snapshot and InstallSnapshot are practical, not theoretical.** In a real etcd cluster, followers that fall too far behind (e.g., they were offline for longer than the log retention window) cannot catch up by replaying log entries because those entries have been compacted. The leader sends a full snapshot instead. Knowing this helps you answer "what happens when a follower rejoins after being offline for a week?" without guessing.

### Senior @ FAANG: Raft Internals and Production Invariants

**The election restriction as a correctness invariant to enforce in code review.** The safety guarantee of Raft (no committed entry is ever lost) depends entirely on the election restriction: a node will not vote for a candidate whose log is less up-to-date than its own. In a code review of a Raft implementation, verify that the vote-granting predicate checks last log term first, then last log index, and that both comparisons are strict. Any relaxation of this predicate is a potential safety violation.

**The no-op entry and linearizable reads.** When a new leader is elected, it does not know what is committed because entries from previous terms can only be committed indirectly. The no-op entry (a dummy log entry at the start of the new term) forces a Raft round trip that confirms the leader's log is fully up-to-date. Only after the no-op is committed can the leader safely serve linearizable reads from its local state. etcd implements this. If you are building a Raft-based system without the no-op entry, linearizable reads will be incorrect during the window between election and first successful commit.

**Prevote as an operational stability improvement.** Without prevote, a partitioned follower repeatedly increments its term while failing to win elections. When it reconnects, it sends RequestVote with a very high term, disrupting the current leader. The prevote optimization (a preliminary "can I win?" phase before incrementing term) prevents this. etcd's Raft library implements prevote and enables it by default. If you are using hashicorp/raft, prevote is configurable. In production clusters with flaky network links, enabling prevote reduces spurious leader changes by 30-50%, which has measurable impact on write availability.

**ADR: synchronous vs. asynchronous apply.** In the standard Raft loop, committing an entry (replicating to majority) and applying it to the state machine are separate operations. The apply loop is asynchronous: entries are applied after being committed, not before the commit acknowledgment is sent to the client. The ADR question is whether reads are served before or after application. Serving reads from the state machine at `lastApplied` rather than `commitIndex` introduces a window of staleness between commit and application. For a configuration store (etcd), this staleness is usually acceptable for serializable reads. For a financial ledger, it is not. Document this choice explicitly.

**Staff concern: Raft group management in multi-Raft systems.** When you have 10,000 Raft groups on a node (as in CockroachDB), the goroutine overhead per group matters. Each group typically needs at least a ticker goroutine and an apply goroutine. At 10,000 groups, that is 20,000 goroutines. Go's scheduler handles this well, but the scheduling jitter from 20,000 goroutines sharing a fixed set of OS threads can cause election timer jitter, leading to spurious elections under load. Production multi-Raft systems (CockroachDB, TiKV) coalesce heartbeats across groups sharing the same peer set and use dedicated goroutine pools for Raft processing. These optimizations are not in the original Raft paper. They are the gap between theory and production.

---
