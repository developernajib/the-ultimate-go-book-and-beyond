## Follow-up Questions

Interviewers often ask these follow-up questions to probe your understanding beyond the core design. Each answer is kept brief because in an interview setting you want to demonstrate breadth of knowledge without getting bogged down in one topic. Be prepared to expand on any of these if the interviewer wants to go deeper.

**1. Multi-device E2E?** Every device is its own identity with its own key pair, so a "user" is really a set of devices and each message is encrypted per device, not per user. Sender keys keep group *messages* at one encryption plus server-side fan-out, but key distribution is still per device.

**2. Message backup?** E2E encrypted to Google Drive/iCloud. The user keeps a 64-digit key, or picks a password whose key is held in an HSM-backed vault that caps guesses.

**3. Disappearing messages?** Client TTL plus Cassandra TTL. Best-effort by nature: the recipient's device already had the plaintext, so this is a UX affordance, not an enforcement mechanism.

**4. Voice/video calls?** WebRTC P2P. TURN for NAT traversal. SFU for group calls.

**5. Spam prevention?** Rate limits per sender and per contact, behavioral detection on metadata (fan-out patterns, account age, report rates), report-based banning. All of it necessarily works on metadata and user reports, since the content is unreadable to the server.

**6. Encrypted search?** Device-only, against a local index built as messages are decrypted.

**7. Communities?** An umbrella structure linking related groups with an announcement channel that only admins post to.


---
