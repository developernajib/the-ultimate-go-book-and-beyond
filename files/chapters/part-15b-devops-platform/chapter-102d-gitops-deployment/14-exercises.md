## 102D.12 Mid-Chapter Practical Exercises

### Exercise 1: Complete GitOps Setup

Set up a local GitOps workflow:
1. Install ArgoCD in a local k3s/kind cluster
2. Create a config repo with Kustomize overlays (dev/staging/prod)
3. Create an ArgoCD Application pointing to the dev overlay
4. Demonstrate: push a change to the config repo, ArgoCD auto-syncs within 3 minutes
5. Demonstrate drift detection: `kubectl scale deployment app --replicas=0`, observe ArgoCD detect and revert it

### Exercise 2: Canary Deployment with Metric Analysis

Deploy Argo Rollouts and configure a canary rollout:
1. Install Argo Rollouts and Prometheus in a kind cluster
2. Deploy a Go HTTP service that returns HTTP 200 (v1) or randomly HTTP 500 (v2 = intentionally buggy)
3. Configure Rollout with 3 canary steps: 10% → 30% → 100%, with Prometheus analysis between steps
4. Trigger a rollout to the buggy v2
5. Observe: Prometheus analysis detects >1% error rate, Rollout automatically aborts and reverts to v1

### Exercise 3: Preview Environment with ApplicationSet

Configure ArgoCD ApplicationSet with PR generator:
1. Set up GitHub webhook to ArgoCD
2. Create ApplicationSet that generates preview environments for open PRs
3. Each PR deploys to `preview-pr-{number}` namespace with PR-specific image
4. Configure automatic cleanup when PR is merged/closed
5. Add cost protection: scale deployments to 0 after 2 hours of inactivity using a CronJob

### Junior → FAANG: Structuring Your Exercise Practice

These three exercises have a deliberate difficulty gradient. Exercise 1 builds the foundation: you need to understand the basic reconciliation loop before canary analysis makes sense. Do not skip to exercise 2 without completing exercise 1 end-to-end, including the drift detection demonstration. Watching ArgoCD revert a manual scale to zero is the moment when GitOps becomes intuitive rather than theoretical.

Exercise 2 is the most important for interview preparation. Being able to describe watching an AnalysisRun detect an elevated error rate and abort a rollout, with specific details about how you observed it happening, is a strong differentiating signal in L4-L5 interviews. Set up a simple Go HTTP service that returns 500 for 15-20% of requests and trigger the rollout. Watch the AnalysisRun events with `kubectl describe analysisrun`. The specific behavior you will observe: the AnalysisRun records the first measurement, possibly a second, then sets phase to Failed and the Rollout controller immediately sets all traffic back to stable.

For exercise 3, the most instructive part is the cleanup mechanism. Preview environments that are not cleaned up become a cost and security problem at scale. Implement the CronJob that checks for idle environments before declaring the exercise complete.

### Senior @ FAANG: Exercises as Platform Design Rehearsal

At staff level, these exercises are rehearsal for platform design decisions. The interesting question for exercise 1 is not whether you can install ArgoCD but what SLO you would set for the ArgoCD service itself. If ArgoCD is unavailable, new deployments cannot be made. What is the acceptable MTTR for ArgoCD unavailability? How does the platform team get alerted when ArgoCD itself becomes unhealthy? This meta-level concern, who monitors the monitoring and who deploys the deployment system, is the kind of question L6 candidates address without being prompted.

Exercise 2 raises the question of how you would design the AnalysisTemplate library for an organization with 50 services. The answer involves versioned analysis templates in the fleet config repository, a template naming convention that encodes the service tier (critical vs standard vs batch), and a platform process for reviewing and approving new AnalysisTemplate definitions before they are deployed. Templates that are too permissive are a reliability risk. Templates that are too strict create alert fatigue and discourage adoption.

Exercise 3 at staff level becomes a platform capacity planning problem. How many preview environments can your cluster support simultaneously? What namespace quota limits prevent a single team from consuming all cluster resources with preview environments? How do you handle the case where a PR's preview environment points to a shared staging database that is also used by the staging environment? Designing the isolation boundary between preview environments and shared dependencies is the core platform engineering challenge that the exercise only hints at.

---
