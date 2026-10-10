## Table of Contents

1. [Healthcare.gov: The $1.7 Billion Website](#90j1-healthcaregov-the-17-billion-website)
2. [Knight Capital: $440 Million in 45 Minutes](#90j2-knight-capital-440-million-in-45-minutes)
3. [TSB Bank: The £330 Million Migration Disaster](#90j3-tsb-bank-the-330-million-migration-disaster)
4. [Atlassian: 14 Days of Deletion](#90j4-atlassian-14-days-of-deletion)
5. [GitLab: When All Five Backups Failed](#90j5-gitlab-when-all-five-backups-failed)
6. [AWS S3: The Typo That Broke the Internet](#90j6-aws-s3-the-typo-that-broke-the-internet)
7. [Roblox: 73 Hours of Darkness](#90j7-roblox-73-hours-of-darkness)
8. [Southwest Airlines: Legacy Code Cancels Christmas](#90j8-southwest-airlines-legacy-code-cancels-christmas)
9. [Post Office Horizon: 25 Years of Injustice](#90j9-post-office-horizon-25-years-of-injustice)
10. [Hershey ERP: The Halloween That Never Came](#90j10-hershey-erp-the-halloween-that-never-came)
11. [FBI Virtual Case File: $170 Million for Nothing](#90j11-fbi-virtual-case-file-170-million-for-nothing)
12. [Flash Crash: $1 Trillion in Minutes](#90j12-flash-crash-1-trillion-in-minutes)
13. [BGP Disasters: Rogers, Optus, and Meta](#90j13-bgp-disasters-rogers-optus-and-meta)
14. [Zillow iBuying: When ML Models Lose $881 Million](#90j14-zillow-ibuying-when-ml-models-lose-881-million)
15. [The Failed Migrations Playbook](#90j15-the-failed-migrations-playbook)
16. [Infrastructure Disaster Prevention Matrix](#90j16-infrastructure-disaster-prevention-matrix)
17. [Amazon Prime Day 2018: When Auto-Scaling Failed](#90j17-amazon-prime-day-2018-when-auto-scaling-failed)
18. [Twitter's Fail Whale: Death of a Monolith (2007-2013)](#90j18-twitters-fail-whale-death-of-a-monolith-2007-2013)
19. [Spotify April 2025: One Envoy Config Took Down Music](#90j19-spotify-april-2025-one-envoy-config-took-down-music)
20. [Discord Auth Outage: ScyllaDB Under Pressure (2023)](#90j20-discord-auth-outage-scylladb-under-pressure-2023)
21. [OpenAI December 2024: Kubernetes Control Plane Collapse](#90j21-openai-december-2024-kubernetes-control-plane-collapse)
22. [Performance Anti-Patterns That Kill Production](#90j22-performance-anti-patterns-that-kill-production)
23. [The Gray Failure Pattern](#90j23-the-gray-failure-pattern)
24. [Telecom Disasters: When Countries Go Dark](#90j24-telecom-disasters-when-countries-go-dark)
25. [Redis Production Disasters](#90j25-redis-production-disasters)

---

### Junior → FAANG: Using the Chapter Map as Interview Preparation

The table of contents for this chapter is a structured checklist of failure archetypes. Before a FAANG behavioral or system design interview, map each section to a failure category you can speak to: Healthcare.gov is scope ambiguity and integration failure, Knight Capital is fleet heterogeneity and dead code, TSB Bank is big-bang migration, GitLab is untested backup, AWS S3 is blast radius and automation safety, Flash Crash is circuit breaker absence, Zillow is ML model drift. When an interviewer asks "tell me about a project that failed," the answer should name the archetype ("this was a Knight Capital-style problem"), describe the specific instance, and explain the control that would have prevented it. Having a taxonomy of fifteen failure patterns means you can anchor any project failure you have experienced to a recognized class rather than describing it as unique bad luck.

### Senior @ FAANG: The Chapter as a Pre-Project Risk Register

At L6, this table of contents is the input to a pre-project risk assessment, not retrospective study material. Before any large migration or infrastructure project begins, run through the chapter headings as a risk checklist: does this project have the scope ambiguity of Healthcare.gov (section 2)? The fleet inconsistency risk of Knight Capital (section 3)? The big-bang cutover risk of TSB Bank (section 4)? The untested backup assumption of GitLab (section 6)? The blast radius problem of AWS S3 (section 7)? The algorithmic feedback loop risk of Flash Crash (section 13)? The ML model drift risk of Zillow (section 15)? For each pattern that applies, define the specific mitigating control before the first line of code is committed: rollback plan, parallel-run duration, blast radius limit, backup verification cadence, circuit breaker threshold. This proactive pattern matching is the staff engineer's most important contribution to project governance. The incidents in this chapter were all preventable with techniques that were well understood at the time. The controls were not in place because nobody applied the pattern taxonomy before the project began. Running this checklist before every major project is the habit that separates engineers who have a clean incident record from those who do not.

---
