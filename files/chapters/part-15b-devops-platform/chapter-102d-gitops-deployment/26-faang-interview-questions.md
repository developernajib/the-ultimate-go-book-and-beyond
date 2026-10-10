## 102D.24 FAANG Senior Platform Interview Questions

### Q1 (Amazon, L6): Design a GitOps rollout for 500 services across 30 clusters.

Use Argo CD ApplicationSets with a cluster generator and a Git generator. Keep one repo per environment tier (dev, staging, prod) and promote via PR. Shard Argo CD by cluster group to cap controller memory. Enforce Sync Waves so CRDs, then namespaces, then workloads apply in order. Use sharded Redis and HA repo-server replicas.

### Q2 (Google, L5): How do you do progressive delivery without a service mesh?

Argo Rollouts with the Kubernetes provider and ingress-based traffic splitting (NGINX canary annotations or ALB weighted target groups). Drive analysis via Prometheus queries against RED metrics. Fall back to replica-based canaries if no weighted routing is available. The loss vs a mesh is per-request precision, not correctness.

### Q3 (Meta, E6): Pull vs push GitOps. Trade-offs.

Pull (Flux/Argo) gives tighter blast-radius, works across firewalls, and makes drift detection free. Push (CI applies kubectl) gives faster feedback on failures but requires cluster credentials in CI, a major supply-chain risk. FAANG-scale answer: pull by default, push only for bootstrap and disaster recovery.

### Q4 (Netflix, Senior): Rollback strategy when a bad manifest reaches prod.

Git revert is the contract, not `kubectl rollout undo`. For immediate mitigation, pause the Argo Application and manually scale the previous ReplicaSet, then open the revert PR. Keep a post-mortem tag on the commit so future audits can find it. Preserve the bad artifact for forensics.

### Q5 (Apple, ICT5): How do you prevent secret leaks in a GitOps repo?

Sealed Secrets or External Secrets Operator with a cloud KMS backend. Pre-commit hooks running gitleaks. Branch protection plus signed commits. Never store plaintext Kubernetes Secrets in Git even in private repos. Assume repo compromise in your threat model.

### Junior → FAANG: How to Practice These Questions Before an Interview

Each of these five questions has a pattern worth internalizing, not just a right answer. Q1 (design a rollout for 500 services across 30 clusters) is a system design question that tests whether you think about scale before functionality. The correct instinct is to start with the constraint: a single ArgoCD controller becomes memory-bound at high Application counts, so sharding is required before you can talk about the rollout strategy itself. Naming the constraint first signals senior thinking.

Q3 (pull vs push trade-offs) is a trade-off question. The expected structure is: state the trade-offs neutrally, give the concrete failure modes for each approach, then give a clear recommendation with conditions. "Pull by default, push only for bootstrap and disaster recovery" is the FAANG-scale answer because it handles the supply-chain risk (CI credentials) without sacrificing the bootstrap use case.

Q4 (rollback when a bad manifest reaches prod) tests whether you know the GitOps rollback primitive. The answer is `git revert`, not `kubectl rollout undo`. The reason: `kubectl rollout undo` reverses the Deployment but does not update Git, so the next ArgoCD sync would re-apply the bad manifest. `git revert` keeps Git as the authority and lets ArgoCD converge correctly. Practice stating this distinction clearly in 30 seconds.

First-job interview preparation: for each of the five questions, write a two-paragraph answer by hand, then reduce it to five bullet points, then reduce it to a 30-second verbal answer. That compression exercise reveals whether you understand the concept or are pattern-matching on keywords.

### Senior @ FAANG: What Bar-Raisers Are Looking for in These Answers

At L6 and above, these five questions are not pass-fail knowledge tests. They are prompts for a conversation about organizational trade-offs, and interviewers are listening for how you think, not just what you know.

Q1 (500 services, 30 clusters) at L6 is really asking about organizational design, not just tooling. The correct answer includes: how do you structure AppProjects so that 500 services can be managed by their owning teams without the platform team becoming a bottleneck? How do you handle onboarding a new service without manual ArgoCD configuration? How do you coordinate a fleet-wide configuration change across 30 clusters without causing a simultaneous rolling update that violates blast radius limits? The RollingSync strategy in ApplicationSet is the technical answer to the last question, but a staff candidate should name the organizational question first.

Q2 (progressive delivery without a service mesh) at L6 tests depth in the traffic-splitting alternatives. The Argo Rollouts NGINX ingress integration uses the `nginx.ingress.kubernetes.io/canary` annotation family to split traffic at the ingress layer, which gives per-request precision but requires all canary traffic to enter through the ingress. ALB weighted target groups give per-connection precision and work for services exposed through AWS Application Load Balancer. Replica-based canaries (split traffic by pod count ratio) are the lowest-fidelity option but work with any networking model. A bar-raiser answer names the precision and fidelity differences, not just the tool names.

Q4 (rollback strategy for a bad manifest) at L6 includes the incident timeline, not just the technical steps. The correct sequence: immediately pause the ArgoCD Application to stop further syncs, assess whether the blast radius requires immediate mitigation (scale the previous ReplicaSet) or can wait for a revert PR, open the `git revert` PR with the on-call as reviewer, merge and verify ArgoCD applies the revert, unpause the Application. Preserving the bad artifact for forensics is a detail that signals operational maturity. A bar-raiser would also ask: how do you prevent this from happening again? The answer connects back to policy-as-code, PR review requirements, and canary analysis, closing the loop to the full GitOps security model.

Q5 (preventing secret leaks) at L6 is a defense-in-depth question. The layered answer: pre-commit hooks with `gitleaks` as the first line of defense (catches before push), CI required check running `gitleaks` on the PR as the second line (catches if pre-commit was bypassed or not installed), admission webhook rejecting Kubernetes `Secret` objects applied directly to the cluster as the third line (catches if someone bypassed Git entirely), and External Secrets Operator as the architectural control that makes plaintext secrets structurally unnecessary. A bar-raiser answer names all four layers and explains why each is required even given the others, because each layer catches a different bypass path.
