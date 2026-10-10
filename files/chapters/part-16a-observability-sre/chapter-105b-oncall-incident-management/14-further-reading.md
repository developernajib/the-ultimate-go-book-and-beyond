## Further Reading

- **Site Reliability Engineering** (Google SRE Book): Chapter 14: Managing Incidents, Chapter 15: Postmortem Culture, Chapter 5: Eliminating Toil
- **The SRE Workbook** (Google): Chapter 5: Alerting on SLOs, multi-burn-rate implementation
- **"Blameless PostMortems and a Just Culture"** by John Allspaw (Etsy engineering blog, 2012)
- **"How Complex Systems Fail"** by Dr. Richard Cook (Cognitive Technologies Laboratory, University of Chicago)
- **"Accelerate"** by Nicole Forsgren, Jez Humble, and Gene Kim: DORA metrics including MTTR
- Prometheus documentation: Recording Rules, Alerting Best Practices
- Kubernetes documentation: Liveness and Readiness Probes, Pod Disruption Budgets
- Go documentation: `runtime/pprof`, `net/http/pprof`, `expvar`, `runtime.MemStats`

### Junior → FAANG: Prioritizing the Reading List

The Google SRE Book (Chapters 5, 14, 15) is the most important item on this list. It is free online and provides the theoretical foundation for everything in this chapter. Read it once before your first on-call rotation and once more after six months of on-call experience: the second reading reveals things the first reading missed because you lacked the context to recognize them.

"How Complex Systems Fail" by Dr. Richard Cook is a five-page paper that explains why major incidents are never caused by a single factor and why blameless post-mortems are the only intellectually honest response. Read it before your first post-mortem.

### Senior @ FAANG: Reading List for Organizational Change

For L6 engineers driving SRE practice adoption, add three organizational change management resources to this list: "The Fearless Organization" by Amy Edmondson (psychological safety is the precondition for blameless postmortems), "Accelerate" by Forsgren, Humble, and Kim (DORA metrics provide the measurement framework for reliability investment), and "Team Topologies" by Skelton and Pais (team structure determines whether SRE practices can scale across an organization). Technical knowledge is necessary but not sufficient for org-wide SRE adoption: the organizational and cultural dimensions require dedicated study.
