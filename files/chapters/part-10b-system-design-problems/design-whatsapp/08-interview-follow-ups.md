## Interview Follow-Ups

These are the most common follow-up questions interviewers ask after you present a WhatsApp design. Each answer demonstrates depth beyond the high-level architecture. Practice delivering these in under 60 seconds each.

**Q: How do you handle 500M concurrent WebSocket connections?**

Horizontal scaling across 1,000+ servers, each handling approximately 500,000 connections on commodity 8-core machines with 32GB RAM. Redis stores a presence mapping (`presence:{userID} → serverID`) so any server can locate any user. Cross-server message routing uses Redis Pub/Sub: the sending server publishes to the target server's channel.

Resist the urge to claim that hashing improves locality. Hashing user IDs to servers is uniform by construction, and two people who message each other constantly have unrelated IDs, so they land on unrelated servers. There is no chat locality to exploit and no way to co-locate a social graph across 500 million connections: essentially every message is a cross-server message, which is exactly why the presence lookup exists rather than being an optimization you could design away. What placement does buy you is a cheap way to find a user's server without a global directory scan, and sticky routing on reconnect so that a flapping client does not churn its presence key.

---

**Q: How do you ensure message ordering?**

Cassandra clusters the `messages` table on `(conv_id, message_id)` where `message_id` is a TimeUUID, so every conversation has a total order and reads come back in it. Ties at the same clock tick are broken by the UUID's node and clock-sequence bits, which is deterministic without a coordinator. Order is defined per conversation, and only per conversation: there is no global order across chats, nobody needs one, and promising one would mean serializing 1.16 million writes per second through a single sequencer.

Two cautions. Compare TimeUUIDs as TimeUUIDs, never as strings. The textual form leads with `time_low`, which wraps roughly every 7 minutes, so a lexicographic sort agrees with time inside one wrap window and scrambles history outside it, which is precisely the bug that passes tests and corrupts production. And note that server-assigned IDs order by *arrival*, not by when the sender typed the message. A device that was offline for an hour gets its messages ordered at reconnect time. Clients therefore also carry a per-conversation sequence number, which lets a recipient detect a gap (a 5 arriving after a 3) and request a retransmit, and lets the UI reason about sender intent rather than server arrival.

---

**Q: What happens when a user rejoins a group and needs message history?**

The server filters messages by the user's join timestamp. Because the table clusters on `message_id`, the filter is expressed against that clustering column rather than `sent_at`: `WHERE conv_id = ? AND message_id > minTimeuuid(?)` with the join time. `minTimeuuid` builds the smallest possible TimeUUID for an instant, which makes it a boundary marker for range scans rather than a real ID, and the query stays a contiguous single-partition scan. Members cannot see historical messages from before their membership. The history is returned paginated via REST (not WebSocket) because loading hundreds of messages at once would saturate the WebSocket connection and delay real-time message delivery. The client fetches pages of 50 messages, scrolling backward on demand.

---

**Q: How do you handle message delivery when the recipient's connection server crashes?**

The connection server crash triggers a TCP reset, and the client's auto-reconnect logic establishes a new WebSocket within 2-5 seconds. When the client reconnects, possibly to a different server, it resumes from its last acknowledged message ID and the server replays anything newer.

The interesting part is the window before the presence key expires, and it is worth being honest about it rather than waving it away. The crashed server's `presence:{userID}` key survives for up to its 5 minute TTL, so the routing layer still believes that server owns the connection and publishes there. Redis Pub/Sub is fire-and-forget: a publish to a channel with zero subscribers is a *success*. So there is no delivery failure to detect, and messages in this window do not fall into the offline queue, because nothing told anyone they needed to. Claiming the fallback catches them is a contradiction, since the fallback is triggered by an error that never occurs.

What actually saves the message is that it was durably written to Cassandra before any routing was attempted. Recovery is pull-based, not push-based: the reconnecting client asks for everything after its last acked ID and gets it, regardless of what the Pub/Sub hop did. Shortening the TTL, or having servers deregister their keys on shutdown, narrows the window for a *clean* shutdown but cannot close it for a crash, which is exactly the case that matters. This is the difference between a design that sounds reliable and one that is: the durable write is the guarantee, and the real-time path is only an optimization on top of it.

---

**Q: How does E2E encryption work for group chats?**

Not by encrypting once per recipient. That approach, client-side fan-out, is the naive design and it is what Sender Keys exist to avoid: it would make the sender's upload cost grow linearly with group size, which is brutal on a phone on a slow network.

WhatsApp uses the Signal Protocol's **Sender Keys** with server-side fan-out. The first time someone posts to a group, their device generates a Sender Key (a chain key plus a signature key pair) and distributes it to each member device once, over the existing pairwise encrypted sessions. That distribution is the only per-member work, and it is amortized across every subsequent message. For each message after that, the sender derives a message key by ratcheting the chain key forward, encrypts the plaintext **once** with AES-256 in CBC mode, signs the ciphertext with the signature key, and uploads a **single** ciphertext. The server fans that one blob out to all members. The signature is what stops a member from forging messages as another member, which a plain shared symmetric key could not prevent.

The properties this buys and costs: ratcheting the chain key gives forward secrecy within the group. The price is that membership changes are expensive rather than free. When a member leaves, every remaining participant must clear the Sender Key and start over, because the departing device still holds a chain key that would otherwise keep deriving future message keys. That re-distribution is O(members), which is a real reason to bound group size, though the published 1,024 limit is a product decision rather than a number you should attribute to a specific millisecond budget.

---

**Q: How do you handle phone number changes or device transfers?**

When a user changes their phone number, the server updates the phone-to-user mapping and notifies all contacts via a "security code changed" alert. The user must re-verify via SMS. For device transfers, the new device generates a fresh key pair and re-registers with the server. The server flags the new identity key to all contacts, triggering the "security code changed" notification visible in chat. Message history does not transfer automatically (the server cannot decrypt it). To preserve history, WhatsApp offers end-to-end encrypted backups to Google Drive or iCloud, keyed independently of the Signal Protocol keys. The user either keeps a 64-digit encryption key themselves, or picks a password, in which case the key goes into an HSM-based Backup Key Vault that enforces a limited number of wrong guesses and then locks the backup permanently. The hardware is doing the work that a password's entropy cannot: it turns an offline brute-force problem, which the attacker would win, into an online one with a hard attempt cap. Neither WhatsApp, Meta, Google, nor Apple can read the backup, and nobody can reset the password for you.

---
