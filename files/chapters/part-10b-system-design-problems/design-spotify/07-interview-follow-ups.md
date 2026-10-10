## Interview Follow-Ups

**Q: How does Discover Weekly work technically?**

1. Collect play history for all users (Kafka → Spark)
2. Train collaborative filtering model (ALS) on implicit feedback (plays = positive, skips = negative signal)
3. Factorization yields a 128-dim vector per user and per track in one shared latent space, so their cosine similarity is a preference score
4. Recommend top-N tracks by cosine similarity that the user has not heard before
5. Post-filter: ensure diversity (not all same artist), check recently played
6. Run weekly, deliver to the user's Discover Weekly playlist for Monday

**Q: How do you handle 50M concurrent streams?**

You do not. The CDN does. The backend is involved only at session start (auth, quality selection, handing back segment URLs), and after that the client fetches segments straight from the edge. That is the whole trick: 5M segment requests/sec never touch your origin, while session starts arrive at a small fraction of that rate because one request buys minutes of playback. Origin fleet sizing follows from the session-start rate, not the stream count, and the gap between those two numbers is what makes the design tractable.

**Q: How are royalties calculated?**

Each "play" = listened ≥ 30 seconds. Play events → Kafka → Spark batch job → per-track play counts per day. Royalty calculation: monthly plays per track / total plays × royalty pool. Paid out monthly per label/distributor contract.

---
