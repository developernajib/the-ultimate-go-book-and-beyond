## 91.1 The Modern Tech Job Market

### How Hiring Actually Works (Not How You Think It Works)

Most engineers apply to jobs by submitting resumes through company career pages and waiting. This is the worst possible strategy. Here's why:

A typical FAANG job posting receives 500-2,000 applications. The funnel looks like this:

| Stage | Candidates | What happens |
|-------|-----------|--------------|
| Applied | 1,000 | ATS scans for keyword matches. ~75% are auto-rejected |
| Recruiter screen | 200 | A recruiter spends **6-10 seconds** per resume. Not 30 seconds, 6 |
| Phone contact | 40-50 | 15-minute call: "Tell me about yourself," salary expectations, timeline |
| Technical screen | 20-25 | 45-60 min coding problem on CoderPad/HackerRank |
| Onsite loop | 8-10 | 4-6 back-to-back interviews (coding, system design, behavioral) |
| Offers | 2-3 | Hiring committee reviews packets, makes offers |
| Hired | 1 | After negotiation |

**The referral shortcut:** Internal referrals skip the ATS entirely and go straight to recruiter review. At Google, referred candidates are **5-10x more likely** to get an interview than cold applicants. At Meta, an internal referral guarantees your resume gets read by a human. This is not optional advice, if you can get a referral, get one.

How to get referrals when you don't know anyone at the company:
- Engage with engineers' open-source work and blog posts. Build a genuine relationship over weeks, then ask
- Attend meetups and conferences. The Go community is tight-knit, GopherCon, local Go meetups
- Alumni networks from your university or previous companies
- LinkedIn: message engineers on the team you want to join (not recruiters). Be specific: "I saw your team's blog post about migrating to gRPC. I've done similar work at [company]. Could I ask you a few questions?"

### What Actually Gets You Hired

Forget the generic "technical skills + soft skills" framework. Here's what hiring managers at FAANG companies actually discuss in debrief meetings:

**1. Can you solve problems we haven't seen before?**

Not "do you know the solution to LeetCode #42." Interviewers want to see your *process* when facing ambiguity. The candidate who says "I've never seen this exact problem, but it looks like it has optimal substructure, let me try DP" is more impressive than the candidate who immediately writes the perfect solution (which looks like they memorized it).

**2. Have you built things that matter?**

"Responsible for backend development" is meaningless. "Designed and built the notification pipeline that handles 2M daily push notifications with 99.97% delivery rate, reducing infrastructure costs by $14K/month" is a hiring signal. Every bullet point on your resume should answer: *what did you build, and what measurable impact did it have?*

**3. Do you make the people around you better?**

This is what separates Senior candidates from Mid candidates. The interviewer asks "tell me about a time you disagreed with a technical decision", they're not testing whether you were right. They're testing whether you handled the disagreement in a way that made the team stronger. Did you present data? Did you listen to the other perspective? Did you commit to the decision even if you disagreed?

**4. Will you thrive here specifically?**

Every company has a different culture. Amazon wants ownership and bias for action. Google wants intellectual depth and ability to handle ambiguity. Meta wants speed and impact. Stripe wants craftsmanship and rigor. Your answers should demonstrate that you've researched *this specific company* and that your working style aligns with theirs.

### The Market Reality for Go Engineers

Go engineers are in high demand for a specific set of roles: backend services, infrastructure, platform engineering, DevOps, and distributed systems. If you're targeting frontend, mobile, or data science roles, Go alone won't get you there.

Companies actively hiring Go engineers (and what they use Go for):
- **Google.** Internal infrastructure, Kubernetes, cloud services
- **Uber.** Microservices platform, geospatial services, real-time dispatch
- **Cloudflare.** Edge computing, DNS, Workers runtime
- **Stripe.** Payment processing, API infrastructure
- **Twitch.** Video processing pipeline, chat services
- **Dropbox.** Backend services (migrated from Python for performance)
- **Docker/Kubernetes ecosystem.** Container tooling, orchestration
- **Startups.** Go is increasingly the default for new backend services due to deployment simplicity and performance

If your target company uses Go, you have an advantage, most candidates interview in Python or Java. Demonstrating fluency in the company's primary language is a signal that you can contribute immediately.

### Junior → FAANG: Reading the Market and Positioning Yourself in It

The funnel numbers in this section are not meant to discourage you. They are meant to redirect your effort. If you are spending most of your job search time on cold applications through career pages, you are optimizing for the part of the funnel with the lowest conversion rate. The highest-leverage activity at early career is referral acquisition, which means building genuine relationships with engineers at your target companies before you need anything from them.

The market reality for Go engineers is a genuine advantage at junior level in infrastructure, platform, and backend-heavy roles. If you are competing for a Go role at a company that uses Go in production, framing your experience in Go-specific terms (goroutine management, interface design, error handling patterns, the standard library over frameworks) signals immediate readiness in a way that a Python or Java candidate cannot match. Name specific Go ecosystem tools in your resume and GitHub projects: if you have used `pprof` for profiling, `net/http` without a framework, or written meaningful table-driven tests, say so explicitly.

Interview entry point: when a recruiter asks why Go, have a concrete answer grounded in tradeoffs, not enthusiasm. "I find Go's compilation speed and deployment model well-suited for the backend infrastructure work I want to do" is more credible than "I just really enjoy working with it."

### Senior @ FAANG: Market Positioning at L6 and Staff

At senior level, the market is not evaluated by funnel conversion rates. It is evaluated by who knows your name before you apply. The most consistently successful senior candidates at FAANG companies either come through internal referrals from known quantities, are recruited directly out of the open-source community or conference circuit, or have a documented record of shipping high-impact work that is visible externally.

The Go ecosystem advantage compounds at senior level. If you are a recognized contributor to a widely-used Go project, or you have given a well-received talk at GopherCon, your market position is categorically different from a comparably skilled engineer who has done the same work in private. Hiring committees at L6 and above are not just asking whether this person can do the job. They are asking whether this person will raise the technical bar of the team. External visibility is one of the strongest signals available for answering that question without relying entirely on the interview loop.

Staff-level market positioning is fundamentally a brand exercise over a three to five year horizon. Governance contributions (CNCF projects, Go proposal authorship, RFC participation in open standards), conference keynotes, widely-cited blog posts, and advisory roles in the startup ecosystem all contribute to a market position where recruiters come to you with pre-leveled conversations. At that point, the job search is a relationship management exercise, not a funnel optimization problem.

---
