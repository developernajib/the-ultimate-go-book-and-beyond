## Performance Testing Checklist

Before going to production, every critical path in the system needs to be validated under realistic load conditions. The table below lists targets for *this* design and how to measure them. They are engineering budgets chosen to hit the latency goals set out in the problem statement, not published WhatsApp figures, and you should treat them as starting points to argue with rather than facts to cite. If a target is missed under test, it points at a bottleneck to resolve before launch.

| Test | Target | Method |
|------|--------|--------|
| Message delivery latency | < 100ms (same region) | End-to-end measurement with test accounts |
| Message delivery latency | < 300ms (cross-region) | Measure with accounts in different regions |
| Connection server capacity | 500K connections/server | Load test with synthetic WebSocket clients |
| Group message fan-out (1024) | < 2 seconds | Benchmark with full-size test group |
| Offline queue flush time | < 5 seconds for 1000 messages | Reconnect test with queued messages |
| Media upload throughput | 100MB in < 30 seconds | Benchmark presigned URL upload path |
| Push notification delivery | < 5 seconds | Measure APNs/FCM delivery time |
| Symmetric ratchet, per message | < 1ms | Benchmark `Encrypt`: a chain step plus one AEAD, tens of microseconds in practice |
| X3DH handshake | < 5ms, **once per session** | Benchmark `InitiateSession`. This is four scalar multiplications, around a millisecond, and it does not recur per message |
| DH ratchet step | < 5ms, once per change of direction | Benchmark `advanceRatchet`: two scalar multiplications plus HKDF |
| Backup encryption speed | Dominated by PBKDF2, not AES | Time the 600k-iteration derivation (a deliberate ~1s), then AES-GCM throughput separately. Conflating them hides which one you are measuring |
| Contact sync time | < 3 seconds for 1000 contacts | Benchmark the batched lookup and the batched block filter together |

---
