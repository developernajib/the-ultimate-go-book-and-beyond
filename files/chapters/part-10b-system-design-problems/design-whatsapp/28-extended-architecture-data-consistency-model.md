## Extended Architecture: Data Consistency Model

Cross-region messaging creates consistency challenges because a message sent from one region must be reliably delivered to a recipient in another. The system uses Cassandra's LOCAL_QUORUM consistency level for writes, which guarantees durability within the local data center without waiting for cross-region replication. Cross-region delivery happens asynchronously through Kafka MirrorMaker.

```
Consistency guarantees per operation:

1. Message write: LOCAL_QUORUM (2 of 3 local replicas)
   - Fast (sub-10ms) because no cross-region wait
   - Durable: survives single-node failure within region

2. Message read (conversation history): LOCAL_QUORUM (2 of 3 local replicas)
   - Overlap rule: R + W > RF. With RF=3 and W=2, a read must also
     touch 2 to be guaranteed to see the write (2 + 2 = 4 > 3).
   - LOCAL_ONE here would be R=1: 1 + 2 = 3, which is NOT greater than
     RF, so the read may land on the one replica that has not received
     the write yet and return a conversation missing its newest message.
     "Written locally, therefore always visible" does not follow.
   - The cost is one extra replica per read, which is the right trade
     when the alternative is a chat that intermittently loses its last
     message.

3. Delivery receipt: LOCAL_QUORUM write + async cross-region
   - Sender may see "delivered" with 100-500ms delay for cross-region

4. Group membership: QUORUM (cross-region)
   - Membership changes must be globally consistent
   - Prevents split-brain where different regions disagree on who is
     in the group
   - This is the expensive one: a cross-region QUORUM pays a WAN round
     trip. It is affordable only because membership changes are rare
     compared to messages. Never put this on the send path.

5. Presence (online status): LOCAL only, no cross-region replication
   - Ephemeral data, not worth replicating
   - Users in different regions may see slightly different online statuses

Conflict resolution:
  - Message rows never conflict. Each is written once, by one author,
    under a unique TimeUUID. Multi-master replication is painful for
    contended mutable rows and nearly free for immutable ones, which
    is why this design leans on immutability rather than on coordination.

  - Status columns DO conflict, and last-write-wins alone does not give
    monotonicity. LWW resolves by cell timestamp, so a "delivered"
    stamped with a later clock can overwrite a "read" that logically
    came after it. Across regions with clock skew, that is not a
    hypothetical: the ticks visibly go backwards.

    Two ways to actually get the guarantee:
      (a) Separate columns. delivered_at and read_at are distinct
          cells, so they cannot clobber one another, and the displayed
          state is derived: read_at set => two blue ticks, else
          delivered_at set => two ticks, else one. This is what the
          schema in this chapter does, and it is why status is derived
          on read rather than trusted as a stored string.
      (b) A monotonic guard on write, only ever advancing the state
          machine sent -> delivered -> read and dropping regressions.

  - Group membership add/remove is the one place a lightweight
    transaction earns its cost, since LWT gives compare-and-set at
    SERIAL consistency (a Paxos round, tens of milliseconds locally and
    far worse across regions). Note the trade being made in this
    chapter's implementation: AddMember does a plain read-then-insert,
    which can overshoot the member cap under concurrency. That is
    deliberate. A group with 1,025 members is a cosmetic defect, and
    paying a Paxos round on every join to prevent it is not obviously
    worth it. Removal is the case that would justify LWT, because a
    removed member who lingers is a security problem rather than a
    cosmetic one.
```

---
