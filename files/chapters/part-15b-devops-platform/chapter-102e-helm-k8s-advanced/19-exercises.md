## Exercises

### Exercise 4: Build a Helm Library Chart with Shared Deployment Template

Create a `company-lib` Helm library chart that provides:
1. A `company-lib.deployment` named template with: rolling update strategy, security context (non-root), readiness/liveness probes, pod anti-affinity (spread across nodes), resource requests/limits, configmap checksum annotation
2. A `company-lib.service` named template: ClusterIP Service with configurable port
3. A `company-lib.pdb` named template: PodDisruptionBudget with `minAvailable: 1`

Then create two consumer charts (`user-service`, `order-service`) that use only the library templates - zero duplicated YAML between the two charts. Package both charts, push to a local OCI registry (`registry.localhost:5000`), and install the umbrella chart that pulls both as dependencies.

Validate: `helm lint` both consumer charts, confirm `helm template` output includes anti-affinity and PDB for both services.

### Exercise 5: Implement a Simple Kubernetes Operator in Go

Using `operator-sdk` and `controller-runtime`, build an operator for a `BackupSchedule` CRD that:
1. CRD spec: `schedule` (cron expression), `targetDeployment` (name), `retentionDays` (int)
2. Controller creates a Kubernetes `CronJob` that runs a backup pod on the given schedule
3. Controller watches for spec changes and updates the CronJob's schedule
4. Finalizer: when `BackupSchedule` is deleted, delete all `Job` objects created by the CronJob and the CronJob itself
5. Status: update `lastBackupTime` and `nextBackupTime` from the CronJob's status

Test with `envtest`: (a) create a `BackupSchedule` → assert CronJob is created with correct schedule. (b) update `retentionDays` → assert CronJob annotations updated. (c) delete `BackupSchedule` → assert CronJob is garbage-collected within 5 seconds.

Deploy to a local `kind` cluster and trigger a manual Job run with `kubectl create job --from=cronjob/<name> manual-test`.

### Junior → FAANG: Exercises 4 and 5 as Portfolio Builders

Exercise 4 (library chart) produces a reusable artifact that demonstrates platform-level thinking, not just application-level Helm usage. The key implementation challenge is that the library chart's named templates receive the calling chart's context (`.Values`, `.Chart`, `.Release`), not the library chart's own context. This means the library templates must be designed around the values schema that consuming charts provide, not a schema the library defines. Getting this right requires understanding how Helm template context works, which is a practical skill that distinguishes library chart authors from chart consumers.

Exercise 5 (BackupSchedule operator) is the most valuable exercise in this chapter for demonstrating Go platform engineering capability. The `envtest` tests are what separate it from a prototype: they verify the operator's behavior against a real API server, not a mock. Being able to explain what `envtest` is (a local API server and etcd binary, no cluster needed), how it differs from a mock-based unit test, and why the difference matters for operator testing is interview-ready depth.

For both exercises, document your design decisions: why did you structure the library chart's values schema the way you did, what CRD fields did you consider and reject for the BackupSchedule spec, how did you test the finalizer cleanup path. Those decision logs are what turn implementation exercises into interview discussion material.

### Senior @ FAANG: Exercises as Platform Design Reviews

Exercise 4 at the staff level is a platform API design review exercise. The library chart's deployment template is a public interface: once consuming charts depend on it, changing the values schema is a migration. Before writing the first line of template code, the staff engineer asks: what is the minimum values schema that covers 80 percent of use cases without over-constraining the remaining 20 percent? The anti-pattern is a library template that is so opinionated it requires consumers to fight it for legitimate customizations. The right level of abstraction leaves room for escape hatches (additional YAML blocks that consumers can inject) while still enforcing the platform-required defaults.

Exercise 5 at the staff level is an operator design review. The `BackupSchedule` CRD design question: should `schedule` be a cron expression string (flexible but unvalidated) or an enum of predefined intervals (constrained but validated at admission)? The answer depends on the organizational threat model: if arbitrary cron expressions are a support burden (teams setting schedules that conflict with backup windows or overwhelm the storage backend), an enum with documented options is the right trade-off. This design decision should be in the ADR, not just in the code comment.

The `envtest` test suite for the operator should include a test for the stuck finalizer scenario: delete the operator deployment, then delete a BackupSchedule resource, and verify that the resource remains in terminating state indefinitely (confirming the finalizer is blocking deletion). This test documents the operational risk and provides a regression check if the finalizer mechanism is ever modified. Writing failure-case tests that verify the operator does NOT do something unsafe under certain conditions is a mark of production-grade test authorship.

---
