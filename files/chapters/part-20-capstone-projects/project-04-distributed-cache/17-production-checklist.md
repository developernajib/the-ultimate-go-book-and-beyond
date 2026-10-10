## Production Checklist

Before deploying GoCache to a production environment, work through every item on this checklist. Each item addresses a specific failure mode or operational concern that could cause downtime or data loss if overlooked. Treat any unchecked item as a blocker for going live.

- [ ] Connection pooling configured
- [ ] Max memory limits set
- [ ] Monitoring and alerts configured
- [ ] Replication enabled for critical data
- [ ] Backup strategy (AOF/RDB snapshots)
- [ ] Rate limiting on client connections
- [ ] Health checks configured
- [ ] Graceful shutdown implemented
- [ ] Load testing completed
- [ ] Disaster recovery plan

---

### Junior → FAANG: Production Checklists as Career Accelerators

Working through a production checklist before a first deployment is a habit that distinguishes professional engineers from those who "deploy and pray." The checklist in this chapter is a template you can adapt for any service you build in your career. Each item represents a lesson learned from a production incident at some company, somewhere.

For entry-level interviews, mentioning that you worked through a production readiness checklist before deploying your project demonstrates operational discipline. It shows you understand that writing code is only part of the engineering job.

The disaster recovery plan item is particularly important: know what you would do if your cache cluster fails completely. For most systems, the answer is "fall back to the database directly, accept increased latency, and rebuild the cache gradually from incoming requests." Having this plan means a cache failure is a performance problem, not a service outage.

### Senior @ FAANG: Production Checklists as Organizational Standards

At senior level, the production checklist is an organizational standard enforced through a launch review process. Before any service goes to production at FAANG, it must pass a launch review with a checklist that covers security (penetration test or security review completed), reliability (runbooks for top failure scenarios, chaos test results), scalability (load test at 2x expected peak traffic), and observability (SLO defined, dashboards created, alerts configured).

The launch review process is most valuable for first-time services. For subsequent deployments of existing services, a lighter-weight "change review" checklist covers only the changes introduced by the new version. This distinction (full launch review versus incremental change review) is a governance decision that must be documented and consistently applied.

Disaster recovery exercises (also called "game days" or "chaos game days") are the practice of intentionally triggering failure scenarios to verify that runbooks are accurate and teams know how to respond. Running a DR exercise quarterly and documenting the results is a reliability engineering practice that strengthens organizational resilience. Planning and running these exercises is a senior engineer responsibility.

---
