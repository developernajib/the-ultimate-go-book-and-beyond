## Production Considerations

Running a messaging system at WhatsApp's scale requires careful attention to monitoring, security, and cost management. This section covers the operational aspects that are often overlooked in system design interviews but are critical for keeping the system reliable in production. Interviewers at staff level and above expect you to discuss these concerns proactively.

### Monitoring and Alerting

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| WebSocket connections per server | > 450K | Scale connection fleet |
| Message delivery latency P99 | > 500ms | Check Redis presence / routing |
| Offline queue size per user | > 10K messages | Investigate stuck consumer |
| Cassandra write latency P99 | > 50ms | Check compaction / disk I/O |
| Push notification delivery rate | < 90% | Check APNs/FCM token freshness |
| Group fan-out time (1024 members) | > 2 seconds | Scale Kafka consumers |
| Redis memory usage | > 80% | Increase cluster size or tune TTLs |
| E2E key exchange failures | > 1% | Check key server health |

### Security Considerations

1. **E2E encryption**: Server stores only ciphertext and holds no key that opens it. It does see routing metadata, and no amount of encryption changes that.
2. **Transport security**: TLS 1.3 for all connections, certificate pinning on mobile apps. TLS protects the hop, E2E protects the payload, and the two are not substitutes.
3. **Key transparency**: Users can verify each other's identity keys via QR code scan or a comparable safety number, which is what turns "trust the key server" into something checkable.
4. **Metadata minimization**: Retain as little as the design allows and expire it aggressively. Note that the ciphertext lives for the 30-day TTL rather than being deleted the instant it is delivered, because the offline queue and multi-device sync both need to replay it. Claiming messages are erased on delivery would contradict the retention this design actually depends on.
5. **Rate limiting**: Per-sender and per-contact caps to blunt bulk messaging, plus forwarding limits. WhatsApp caps forwarding at 5 chats at a time, and once a message has travelled a chain of more than five chats it is marked frequently forwarded and drops to one chat at a time. This is a neat example of designing against virality using only metadata: the hop count is known, the content never is.
6. **Spam detection**: Behavioral analysis over metadata and report-based banning. This necessarily works on fan-out patterns, account age, and reports rather than content, which the server cannot inspect.
7. **Device verification**: SMS OTP on registration, optional two-factor PIN. Every new device is a new identity key, so contacts get a "security code changed" notice.
8. **Backup encryption**: Cloud backups E2E encrypted with either a 64-digit key the user keeps or a password whose key lives in an HSM-backed vault that caps guessing attempts.

### Cost Optimization

The figures below are order-of-magnitude sketches at list prices, meant to show where the money concentrates rather than to be quoted. Real costs at this scale are dominated by negotiated rates, owned hardware, and private interconnects, which is exactly why WhatsApp ran on its own machines.

| Component | Rough monthly order | Optimization |
|-----------|-------------|--------------|
| Connection servers (1,000) | ~$1M | Cheap per connection: the cost is holding sockets, not CPU. WhatsApp famously used Erlang/BEAM and FreeBSD to push connection counts per box |
| Redis Cluster (presence + queue) | ~$200K | TTL eviction, compact message encoding |
| Cassandra (messages) | ~$500K | 30-day TTL auto-delete, compression |
| S3 + CDN (media) | Millions, and the largest line by far | 2PB/day ingest against 10TB/day of text. Lifecycle expiry at 30 days, and CDN egress usually costs more than the storage under it |
| Push notifications (APNs/FCM) | ~$50K | APNs and FCM are free to send: the cost is the fleet that calls them |
| PostgreSQL (user metadata) | ~$20K | Read replicas for contact sync |

The shape is the lesson: media is two orders of magnitude larger than text, so media handling drives the bill even though messaging is the product. That is the reason bytes never traverse the application servers and the reason a 30-day expiry is an architectural decision rather than a tidy-up.


---
