## Interview Follow-Ups

These are the most common follow-up questions interviewers ask after you present your high-level design. Having clear, concise answers ready for each one demonstrates depth of understanding and separates strong candidates from those who only memorized the architecture diagram. Practice answering each in 60-90 seconds.

**Q: How does adaptive bitrate streaming work technically?**

The player downloads a multivariant manifest (HLS `.m3u8`) listing every rung. It starts at a conservative middle rung, because it has no bandwidth measurement yet, then measures each segment's download time against the segment's duration to estimate throughput. Downloading 6 seconds of video in 2 seconds means roughly 3× headroom, so it can climb. If a download is tracking to miss its deadline, it drops immediately rather than risk the buffer draining. All of this runs in the player, with no server-side state, which is what lets the CDN serve plain static files. Switching is seamless only because every rung is keyframe-aligned on the same segment grid, so segments are interchangeable at their boundaries.

Two things candidates routinely get wrong here. The player must measure the client's own downloads, not any server-side timing, since the whole point is the last mile. And the cold start is a real design decision, not an oversight: with no measurement yet, starting at the lowest rung means everyone's first seconds look bad, and starting at the highest means everyone on a weak link rebuffers instantly.

---

**Q: How does Netflix determine what content to cache at each PoP?**

Netflix's Open Connect appliances sit inside ISP data centers. A central system predicts next-day viewing per region from watch history, trending signals, and release schedules, ranks candidates by predicted views per byte of storage, and hands each appliance a fill list. Content is then pushed from origin during a nightly off-peak window that Netflix's partner documentation describes as 10 to 12 hours, typically 2AM to noon local, at up to 1.2Gbps per appliance. The result is that the appliance answers requests locally, so the ISP carries no upstream traffic for it and Netflix pays no transit.

The ranking is a greedy knapsack: sort by value density, fill until the disk is full. Two implementation details matter more than the model. Skip items too large to fit rather than stopping at the first one, or a single large title near the top of the ranking leaves the appliance half empty. And guard against a zero or missing size, since dividing by it yields +Inf and puts a corrupt row at the head of the list.

---

**Q: How do you handle video seeking efficiently?**

Seeking to minute 45 means fetching segment number `45*60/6 = 450`. The player requests only that segment from the CDN, and because segments are static objects addressed by name, no server-side session state exists at all.

For scrub previews, precompute a sprite sheet at upload time: one small frame every few seconds, tiled into a grid, plus a metadata file mapping timestamps to tile coordinates. The client fetches the sheet once and renders previews locally with no further requests. Size it deliberately rather than assuming: a 2-hour film at one frame per 10 seconds is 720 tiles, which at thumbnail resolution is a multi-megabyte image, too much to make a viewer wait for. The standard answer is tiered sheets, a coarse one fetched eagerly and finer ones fetched lazily around wherever the user is actually scrubbing.

---

**Q: How do you prevent unauthorized CDN URL sharing?**

Start by rejecting the obvious answer. Signing just the master playlist URL with `?token=...` protects nothing: the variant URIs inside a playlist are relative, and relative URL resolution discards the query string, so the media playlists and every segment are fetched with no token. You signed the only file that contains no video.

The working answer is to authorize a **prefix**, not a file. Issue signed cookies scoped to `/videos/{video_id}/`, carrying an HMAC over the prefix, the user, and an expiry. The player attaches them to every request under that path automatically, and the edge validates on the segments, where it matters. Short expiry, 4 hours or less, and rotate the signing key. Native mobile players that handle cookies poorly get short-lived signed URLs per media playlist instead.

Be honest about the limits, because a good interviewer will push. This raises the cost of casual link-sharing. It does not stop a determined user, who can share the cookie as easily as the URL. Binding the token to an IP is a common suggestion and a bad one: mobile clients change IP mid-session moving between cell and Wi-Fi, so you break legitimate playback to inconvenience an attacker who can use a proxy. Binding to a user-agent is trivially forged. Signed URLs are anti-leeching, not access control. The real control for premium content is DRM (Widevine, FairPlay, PlayReady): the segments themselves are encrypted, and playback needs a license the license server issues only after checking entitlement. That moves enforcement from "who fetched the bytes" to "who can decrypt them", which is a much stronger position, and it is still not unbreakable. Every DRM has been circumvented, hardware-backed levels raise the bar rather than close the door, and the industry's realistic goal is to make piracy inconvenient enough that legitimate playback is easier.

---

**Q: How would you scale transcoding to handle a 10× spike (5,000 hours/min)?**

Auto-scale the Spot fleet on SQS queue depth rather than on CPU, since queue depth is the only signal that leads demand instead of lagging it. Separate queues by priority so premium creators are not stuck behind a bulk backlog.

The move that actually wins this question is changing what "done" means. Instead of scaling until you can encode everything fast, encode the bottom rungs first, on a fast path (Lambda works well here, the jobs are small and embarrassingly parallel), publish the video as soon as 240p and 360p exist, and let the higher rungs land minutes later. The viewer gets a watchable video almost immediately and the ladder fills in underneath them. You have converted a capacity problem into a latency-tiering problem, which is far cheaper. The requirement this leans on is that publishing is not all-or-nothing, so make sure the manifest generator advertises only the rungs that exist right now and gets regenerated as more arrive. Advertise a rung before it is written and you are back to a 404 on every segment of that variant.

---

**Q: How do you handle duplicate video detection at YouTube scale?**

Perceptual video hashing: extract frames at 1fps, compute a difference hash (dHash) per frame, and concatenate into a fingerprint. Perceptual, not cryptographic: the point is that a re-encoded, cropped, or slightly recolored copy hashes to something *near* the original, which is exactly the property SHA-256 is designed to destroy. Compare with locality-sensitive hashing, where similar fingerprints collide into the same bucket, so you probe a handful of buckets instead of scanning the corpus. That is sublinear, not O(1), and it is approximate by construction: LSH trades recall for speed, and tuning that trade is the actual engineering.

Copyright detection is the same machinery pointed at a different corpus. YouTube's Content ID is public: rights holders submit reference files, uploads are matched against the reference database, and a match triggers the rights holder's chosen policy, which is typically monetize, track, or block. Note that the hard part is not the matching, it is the policy and dispute surface around a false positive, since a fingerprint match cannot tell infringement from fair use.

---
