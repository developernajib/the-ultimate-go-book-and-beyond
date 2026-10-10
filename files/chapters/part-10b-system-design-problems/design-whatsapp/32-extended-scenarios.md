## Extended Scenarios: Business Features

### WhatsApp Business API

When businesses use WhatsApp to communicate with customers at scale:

1. **Rate limiting**: Business accounts get an explicit throughput tier rather than the implicit consumer limits, so capacity is provisioned and abuse is bounded
2. **Template messages**: Pre-approved message templates for outbound notifications (shipping updates, appointment reminders)
3. **Session window**: Free-form messaging allowed only within 24 hours of a user-initiated message, outside that window, only template messages are allowed
4. **Webhook delivery**: Business messages delivered via HTTPS webhooks to the business server, not via WebSocket
5. **Message queuing**: If the business webhook is down, queue messages with exponential backoff and jitter, and drop to a dead-letter queue once the retry budget expires rather than retrying forever
6. **Analytics**: Track delivery, read, and reply rates per template. Note this is metadata analytics: it counts events, it does not read conversations

The 24-hour session window is the part worth understanding rather than memorizing, because it is a product rule enforcing a consent model, not a technical limit. A user messaging a business opens a window in which the business may reply freely. Outside it, the business may only send pre-approved templates. The effect is that businesses cannot initiate arbitrary conversations with people who have not engaged them, which is spam control implemented as a state machine on the conversation rather than as content filtering the server could not perform anyway.

### Multi-Device Synchronization

This is the hardest part of the design, and the interesting thing is how the architecture had to change to make it work. The obvious model, and the one WhatsApp originally shipped, treats the phone as the source of truth: companion devices are terminals, the phone receives every message, re-encrypts it, and relays it onward. It is simple and it has a fatal property, which is that the phone must be online for anything else to work. If your phone is dead, your laptop is dead.

WhatsApp's multi-device architecture, introduced in 2021, removed the phone from that position. The model to describe now:

1. **No primary device**: Each companion connects to the server independently, and the phone can be off. There is no relay in the middle.
2. **Per-device identity keys**: Every device generates its **own** identity key locally. The key is never copied from the phone. The server keeps a map from account to the list of device identities, and that map is what a sender resolves against.
3. **A user is a set of devices**: This is the whole conceptual shift, and it is what the cryptography follows from. Sending to Alice means sending to each of Alice's devices, and a message is encrypted once per *device*, in a separate pairwise session per device. Four devices is four ciphertexts.
4. **Sender keys for groups**: A group message is encrypted once with the sender's own Sender Key and fanned out by the server. Note the precision: each sender has their own sender key rather than the group sharing a single symmetric key, and the sender key is distributed to every member *device* over the pairwise sessions.
5. **History sync on link**: A newly linked device has no past messages, since it did not exist when they were encrypted and no ratchet state can reach backwards. History is transferred deliberately, encrypted to the new device, rather than appearing for free.
6. **Offline companion**: A device that is offline gets its queued messages when it reconnects, exactly like any other device, because it is a first-class recipient rather than a mirror.
7. **Device linking**: The phone scans a QR code, typically gated behind biometric authentication. This authorizes the new device's own key and adds it to the account's device list. Contacts see a security-code change, because the set of keys they encrypt to has genuinely changed.

The cost of this model is that revocation is now a real operation. Unlinking a device must remove it from the device list and force the group Sender Keys to be rotated, or the unlinked device keeps deriving message keys from a chain it still holds. "The phone stopped relaying to it" was a crude form of revocation that came for free in the old model, and independence takes it away.
