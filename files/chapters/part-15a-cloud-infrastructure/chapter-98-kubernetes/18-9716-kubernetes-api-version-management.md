## 98.18 Kubernetes API Version Management

Understanding API version lifecycle prevents breaking deployments during cluster upgrades.

### API Version Lifecycle

| Stage | Example | Description |
|-------|---------|-------------|
| **Alpha** | `v1alpha1` | Experimental, may be removed without notice, disabled by default |
| **Beta** | `v1beta1` | Well-tested, enabled by default, schema/semantics may still change |
| **Stable** | `v1` | GA, backward-compatible, safe for production use |

### Common Deprecated APIs

Watch for these when upgrading clusters:

| Old API | Removed In | Replacement |
|---------|-----------|-------------|
| `extensions/v1beta1` Ingress | K8s 1.22 | `networking.k8s.io/v1` |
| `apps/v1beta1` Deployment | K8s 1.16 | `apps/v1` |
| `batch/v1beta1` CronJob | K8s 1.25 | `batch/v1` |
| `policy/v1beta1` PodSecurityPolicy | K8s 1.25 | Removed (use Pod Security Admission) |
| `autoscaling/v2beta2` HPA | K8s 1.26 | `autoscaling/v2` |

### Detection Tools

Catching deprecated API usage before a cluster upgrade is critical, applying a manifest that references a removed API version will fail silently in CI but cause a hard error in production. `pluto` and `kubent` solve this by cross-referencing your manifests and running workloads against Kubernetes deprecation data, surfacing every API that will be removed in the target version. Integrating `kubeconform` into the CI pipeline adds schema validation on top of deprecation checks, rejecting malformed manifests before they ever reach the cluster.

```bash
# Check for deprecated APIs in manifests
kubectl api-versions                          # list available versions
kubectl get --raw /apis                       # raw API discovery
pluto detect-files -d ./k8s/                  # scan manifest directory
kubent                                        # check running cluster

# In CI/CD pipeline
kubeval --strict -d ./k8s/                    # validate manifests
kubeconform -strict ./k8s/                    # faster alternative
```

### Best Practices

- **Pin to stable** - use `v1` API versions whenever possible
- **CI/CD gates** - add `pluto` or `kubent` to catch deprecations before deploy
- **Stay informed** - subscribe to Kubernetes release notes for deprecation announcements
- **Stage first** - test cluster upgrades in staging with `--warnings-as-errors` flag
- **Helm charts** - use `apiVersion: v2` and keep chart dependencies updated

---

### Junior → FAANG: API Version Awareness as a Deployment Safety Habit

Kubernetes API versions follow a progression: alpha (`v1alpha1`) means unstable and subject to change, beta (`v1beta1`) means mostly stable but details may change, stable (`v1`) means the API is committed for backwards compatibility. The practical consequence: manifests using alpha or beta APIs may stop working after a cluster upgrade.

The first-job habit: always check the current stable API version for any resource you are using. `kubectl api-versions` shows what the current cluster supports. `kubectl api-resources` shows the preferred version for each resource type. The preferred version is what you should use in new manifests.

Before any cluster upgrade in your organization, run `kubectl convert` or `pluto` against all manifests in the repository to find deprecated API usage. Finding deprecated APIs before the upgrade rather than after prevents the upgrade from breaking running deployments.

### Senior @ FAANG: Kubernetes API Version Governance and Cluster Upgrade Strategy

At staff level, API version management is part of the cluster upgrade strategy, which is itself a major platform engineering responsibility. Kubernetes releases three minor versions per year (since the annual cadence change), and each version deprecates and removes some APIs that were deprecated in previous versions. The platform team must track these changes and coordinate migration across all teams before each upgrade.

The governance mechanism that makes this manageable: automated scanning of all manifests in all repositories for deprecated API usage, run as a CI gate on every PR that touches cluster manifests, and as a periodic batch scan across the entire codebase with results published to a central dashboard. Teams see their deprecated API usage as a required PR check failure, not as a surprise during the upgrade window.

The cluster upgrade process itself requires a staged rollout: upgrade the staging cluster first, run a full suite of integration and e2e tests against the upgraded cluster, hold for a burn-in period (typically one week), then upgrade production. The upgrade itself should use the node group rolling update mechanism (drain and replace nodes one at a time) to maintain availability throughout. The platform team owns the upgrade runbook, the rollback criteria, and the communication plan to all teams using the cluster. This is an operational engineering effort that spans multiple weeks and requires coordination across the entire engineering organization, which is squarely in the L6/L7 responsibility space.
