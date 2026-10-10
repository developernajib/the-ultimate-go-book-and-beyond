## Extended Scenarios: Partitions and Broadcast Lists

These scenarios explore edge cases and advanced features that interviewers may ask about to test your depth of understanding. Each scenario involves a situation where the basic design needs to be extended or adapted, and your answer should demonstrate that you understand the tradeoffs involved.

### Handling Message Delivery Across Network Partitions

When inter-region network connectivity is disrupted:

1. **Local writes succeed**: Messages stored in local Cassandra with LOCAL_QUORUM
2. **Kafka replication paused**: Cross-region Kafka MirrorMaker buffers events
3. **Sender sees "sent"** (single checkmark), server received the message
4. **On partition heal**: Kafka replays buffered events to remote region
5. **Remote delivery occurs**: Recipient receives message, sends delivery receipt
6. **Sender sees "delivered"** (double checkmark), may be delayed by minutes

Delivery is delayed rather than denied, and the ticks tell the truth throughout: one tick means the server has it, two means the recipient's device does, and during a partition the message honestly sits at one. That is the useful property, because the UI never lies about a state the system has not reached.

Be careful with "no messages are ever lost", though, because it is a guarantee with conditions and an interviewer will look for whether you know them. The message survives because it is durably in the local Cassandra at `LOCAL_QUORUM` before anything else happens, so a partition delays replication rather than destroying data. But that holds only while the buffers hold. MirrorMaker's backlog is bounded by the source topic's retention: a partition lasting longer than that retention drops the un-replicated events off the end, and no amount of healing brings them back. The honest formulation is that delivery is guaranteed as long as the partition is shorter than your retention window, which is a number you chose and should be able to state. Longer than that, and recovery depends on the durable store being reconciled directly rather than on the event stream.

### Handling 100K-Member Broadcast Lists

For business broadcast messages (one sender to 100K+ recipients). Note the scale here is business-messaging territory: consumer broadcast lists are capped far lower, and a list is not a group, since recipients see a direct message and cannot see each other.

1. **Store one row per recipient**, because under pairwise E2E each recipient's ciphertext genuinely differs (see below). Store the *campaign* once and the per-recipient ciphertext against each recipient's conversation
2. **Fan-out via dedicated Kafka topic** with high partition count (100+)
3. **100 consumer workers** each handle 1000 recipients
4. **Rate limit delivery**: 10K messages/second, so 100K recipients drain in roughly 10 seconds without starving interactive traffic on the connection servers
5. **Track delivery per-recipient** in a separate delivery_status table
6. **Isolate from interactive traffic**: broadcasts are throughput work and should never share a consumer group with one-to-one messages, or a large campaign adds latency to ordinary chats

The encryption cost is the part this list makes look easier than it is. Sender Keys make *group* messages cheap because a group is one shared cryptographic context: encrypt once, let the server fan out. A broadcast list is not a group. Each recipient gets what is, cryptographically, a pairwise message, so the sender's device must maintain a session with every recipient device and encrypt the payload once per device. At 100K recipients that is 100K encryptions and 100K pairwise sessions on a phone, which is precisely why consumer broadcast lists are small and why large-scale business messaging runs through a different product with a different trust model, typically with the business's messages handled by a server the business or its provider operates. "Store once, fan out from the server" describes the *ciphertext* only when a single ciphertext is meaningful to every recipient. Under pairwise E2E it is not.


---
