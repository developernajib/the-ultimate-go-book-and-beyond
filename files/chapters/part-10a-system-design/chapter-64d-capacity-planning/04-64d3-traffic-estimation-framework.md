## 64D.3 Traffic Estimation Framework

### The Four-Step Framework

Every traffic estimation follows the same four steps:

1. **Start with DAU** (Daily Active Users)
2. **Estimate actions per user per day**
3. **Calculate requests per second (RPS)**
4. **Apply peak multiplier**

### Step 1: DAU as the Starting Point

DAU is the fundamental unit of scale estimation. All traffic derives from how many users are active per day and what they do.

Typical DAU/MAU ratios for reference:
- Facebook: ~65% (DAU/MAU) - highly habitual usage
- Twitter: ~50%
- LinkedIn: ~20% - less frequent professional use
- Slack (work): ~70% - daily work tool

If an interviewer gives you MAU (Monthly Active Users), convert:

```
DAU = MAU × (DAU/MAU ratio)
Twitter: 300M MAU × 50% = 150M DAU
```

### Step 2: Actions Per User Per Day

Estimate read and write actions separately. Systems almost always have vastly more reads than writes.

**Twitter example**:
- Timeline reads: 10 per user per day (scroll timeline)
- Profile reads: 2 per user per day (view other profiles)
- Tweet writes: 0.1 per user per day (1 tweet per 10 days on average - most users lurk)
- Like/retweet/reply: 5 per user per day

**Instagram example**:
- Feed views: 8 per user per day
- Story views: 20 per user per day
- Profile views: 3 per user per day
- Photo uploads: 0.05 per user per day (1 photo per 20 days)
- Likes/comments: 10 per user per day

### Step 3: Requests Per Second

Dividing total daily actions by seconds per day converts an intuitive user-behavior estimate into the engineering unit that drives server sizing decisions. The key insight is to approximate 86,400 seconds as 100,000, a 15% overestimate that is acceptable for back-of-envelope work and ensures you never under-provision. Read and write RPS must be kept separate because they hit fundamentally different system layers: reads are served from caches and read replicas, while writes must reach primary storage and fan out to dependent data structures.

```
RPS = (DAU × actions per user) / seconds per day

Seconds per day = 24 × 60 × 60 = 86,400 ≈ 100,000

(This approximation simplifies the math; ≈15% error is acceptable for BOE)
```

**Twitter timeline reads**:
```
RPS = (150M DAU × 10 reads/day) / 100,000 seconds
    = 1,500,000,000 / 100,000
    = 15,000 reads/second
```

### Step 4: Peak Multiplier

Traffic is not uniform throughout the day. Apply a peak multiplier to get peak RPS:

- **Standard**: 2-3x daily average (web applications, social media)
- **Event-driven**: 5-10x during events (sports, product launches, news)
- **Regional**: Account for timezone concentration (US traffic peaks 9am-9pm EST)

**Twitter peak reads**:
```
Peak RPS = 15,000 × 2.5 = 37,500 reads/second
```

### Worked Example: Twitter at Scale

**Given**: Twitter has 400M DAU.

**Step 1: Read traffic**

```
Assumptions:
- Each user reads timeline 10 times/day = 10 feed loads
- Each feed load returns 20 tweets = 200 tweet reads/user/day
- 50% of reads are retweets/replies (complex queries)

Total read requests:
= 400M users × 10 timeline loads/day
= 4,000M requests/day
= 4B / 100,000 seconds
= 40,000 RPS (average)
= 40,000 × 2.5 = 100,000 peak RPS
```

**Step 2: Write traffic**

```
Assumptions:
- 1% of users tweet per day (4M users)
- Average user who tweets: 3 tweets/day
- Total tweets: 4M × 3 = 12M tweets/day

Tweet write RPS:
= 12M / 100,000
= 120 RPS average
= 120 × 5 = 600 peak RPS (spikey - news events cause write spikes)
```

**Step 3: Fan-out writes**

```
Twitter's complexity: when a user with 1M followers tweets,
that tweet must be written to 1M home timelines (fan-out).

Average follower count: 200
Fan-out writes per tweet: 120 RPS × 200 followers = 24,000 fan-out writes/second
Peak fan-out: 600 RPS × 200 = 120,000 fan-out writes/second

Note: Celebrity accounts (Obama: 130M followers) require special handling  - 
fan-out at tweet creation is impractical. Instead, pull from celebrity timelines
at read time (hybrid fan-out/fan-in model).
```

### Worked Example: YouTube at Scale

**Given**: YouTube has 2B logged-in users/month, ~800M DAU, 500 hours of video uploaded per minute.

**Upload traffic**:
```
500 hours/minute = 30,000 hours/hour = 720,000 hours/day

Average video: 7 minutes = 0.117 hours
Videos uploaded per day: 720,000 / 0.117 ≈ 6M videos/day

Average video size (1080p): 50 MB/min × 7 min = 350 MB
Ingress bandwidth: 6M videos × 350 MB / 86,400 seconds
= 2.1 PB/day / 86,400
= ~24 GB/second ingress

YouTube stores multiple resolutions (360p, 480p, 720p, 1080p, 4K)
with transcoding factor: ~5x storage per video
Total storage written per day: 2.1 PB × 5 = 10.5 PB/day
```

**View traffic**:
```
800M DAU × 30 minutes of video watched per day
= 24B minutes/day of video consumed

Average concurrency (simultaneous streams):
= 24B minutes / 1,440 minutes per day
≈ 16.7M simultaneous streams

Average bitrate (weighted mix of resolutions): ~3 Mbps per stream

Total egress bandwidth:
= 16.7M streams × 3 Mbps
= 50 Tbps egress

This is CDN egress. YouTube's CDN (Google's network) distributes this
load across hundreds of PoPs globally.
```

### Junior → FAANG: Executing the Four-Step Framework Fluently Under Pressure

The four-step traffic estimation framework is the script you run at the beginning of every system design interview. The risk for junior engineers is not forgetting the steps: it is executing them slowly, getting lost in arithmetic, or skipping steps under interview pressure.

**Practicing the DAU-to-RPS conversion until it is muscle memory.** The core arithmetic is always the same: multiply DAU by actions per user, then divide by 100,000. The only variables are the numbers. Practice running through five different systems (Twitter, Instagram, Uber, WhatsApp, Netflix) until you can produce average RPS in under 30 seconds for each. Then practice applying the peak multiplier and stating both numbers: "average 15,000 reads per second, peak 37,500 reads per second."

**The read-write separation habit.** Every traffic estimate must produce two separate numbers: read RPS and write RPS. Systems designed for a combined RPS figure will be architected incorrectly because reads and writes hit different infrastructure. Cache serves reads, not writes. Read replicas serve reads, not writes. A candidate who produces a single "RPS" number without separating reads and writes will design a cache layer and a database tier with wrong sizing. Practice stating both numbers every time.

**Fan-out is the hidden complexity.** The Twitter fan-out example (120 write RPS becoming 24,000 fan-out writes per second) is one of the most important estimation insights in system design. Every social media write triggers downstream writes proportional to follower count. Every payment triggers downstream events in accounting, fraud, and notification systems. For any write-heavy system, ask: "What does this write trigger?" and add the fan-out RPS to your write estimate. Candidates who miss fan-out consistently underestimate write infrastructure requirements.

**First-job habit:** When your team deploys a new feature, run the four-step estimation before it launches. Then compare your estimate to actual production metrics one week later. The error in your estimate teaches you more about calibration than any textbook. Track your estimation errors over time and identify which assumptions consistently go wrong (peak multiplier too low, actions per user underestimated, fan-out ignored).

**Interview entry point:** "YouTube uploads 500 hours of video per minute. Estimate the ingress bandwidth." The expected answer works through: 500 hours per wall-clock minute is 30,000 minutes of video per minute, or 500 minutes of video per second. At a 1080p source bitrate of roughly 7 Mbps (about 50 MB per minute of video), that is 500 times 50 MB, which is 25,000 MB per second, approximately 24 GB per second of ingress. Then add the transcoding fan-out: YouTube stores about five resolutions, multiplying the storage write rate by roughly five to about 120 GB per second written. Candidates who work through this chain, even approximately, demonstrate the structured thinking interviewers value.

### Senior @ FAANG: Traffic Estimation as a Design Review and Incident Analysis Tool

At senior level, the four-step traffic estimation framework is not just interview preparation. It is the analytical tool you use in design reviews to validate that proposed architectures are sized correctly, and in incident retrospectives to determine whether a capacity failure was predictable.

**Using traffic estimation to challenge architecture proposals.** When a team proposes a new service architecture in a design review, a staff engineer runs the estimation in real time. "You said 10M DAU with 20 actions per user per day. That is 2 billion actions per day, or about 20,000 average RPS, and 60,000 at peak. Your proposal shows three application servers each handling 5,000 RPS. That is 15,000 total capacity at 70% utilization, which is below your peak of 60,000. The proposal needs five times more application server capacity." This kind of quantitative pushback, done during the review, prevents capacity incidents before they happen.

**ADR: peak multiplier selection by traffic pattern type.** The standard 2-3x peak multiplier applies to social media and e-commerce with typical diurnal patterns. Event-driven workloads (concert ticket sales, sports broadcasts, product launches) require 5-10x or more. A service that sells tickets for major events and uses a 3x peak multiplier will fail at every major sale. An ADR for the traffic estimation policy of a new service should specify: what is the traffic pattern type, what peak multiplier is used, and what evidence supports that multiplier (historical traffic data, comparable system benchmarks, or first-principles analysis of the event trigger)? Multiplier choices that are not grounded in evidence become the source of capacity incidents.

**Fan-out amplification as a platform governance concern.** In a large system, fan-out amplification can create write storms that affect shared infrastructure. A single viral tweet by a high-follower account can generate millions of fan-out writes in seconds, consuming database write bandwidth, Kafka partition throughput, and cache invalidation capacity across the platform. Staff engineers who own platform infrastructure must model the worst-case fan-out scenario (top celebrity account times average follower count times peak tweet rate) and ensure the platform can absorb it without degrading other services. This is a capacity planning concern that individual service teams rarely think about but platform engineers must.

**Governance: traffic estimation as a pre-launch gate.** A mature engineering organization requires a traffic estimate with peak RPS calculation before any feature that changes traffic patterns can launch. The estimate is reviewed by the relevant infrastructure owner (database team, cache team, CDN team), who validates that existing capacity can absorb the new load at the headroom target. If it cannot, the feature launch is gated on capacity provisioning. A staff engineer writes and enforces this pre-launch gate as part of the team's release process.

**L6/L7 concern: probabilistic traffic modeling for tail risk.** The four-step framework produces a point estimate (a single peak RPS number). In practice, peak traffic is a distribution, not a point. For capacity planning at L6/L7 precision, the question is: what is the 99th percentile peak traffic for this service over the next quarter, given the uncertainty in user growth rate, event frequency, and seasonality? This requires probabilistic modeling: running Monte Carlo simulations over the input distributions to produce a confidence interval on peak RPS. A staff engineer building a capacity model for a high-stakes service uses this probabilistic approach to set capacity targets that protect against tail risk, not just expected peak.

---
