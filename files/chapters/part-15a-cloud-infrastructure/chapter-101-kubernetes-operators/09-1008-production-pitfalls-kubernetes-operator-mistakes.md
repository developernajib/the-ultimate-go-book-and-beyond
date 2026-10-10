## 101.9 Production Pitfalls: Kubernetes Operator Mistakes

### Pitfall 1: Missing Finalizers Leading to Orphaned Resources

**Real Incident Report**: An operator created AWS RDS instances for CRDs. When users deleted the CRD, Kubernetes removed it immediately - but the RDS instance kept running. The operator never got a chance to clean up. After a month, the team had 50 orphaned RDS instances costing $15,000/month.

**The Anti-Pattern**:
```go
// WRONG: No finalizer - external resources orphaned on delete
func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var db myv1.Database
    if err := r.Get(ctx, req.NamespacedName, &db); err != nil {
        // Object deleted - but AWS resource is still running!
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Create AWS RDS...
    return ctrl.Result{}, nil
}
```

**The Better Approach**:
```go
const finalizerName = "database.my.domain/finalizer"

func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var db myv1.Database
    if err := r.Get(ctx, req.NamespacedName, &db); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Check if being deleted
    if !db.DeletionTimestamp.IsZero() {
        if containsString(db.Finalizers, finalizerName) {
            // Clean up external resources
            if err := r.deleteRDSInstance(ctx, &db); err != nil {
                return ctrl.Result{}, err
            }

            // Remove finalizer to allow deletion
            db.Finalizers = removeString(db.Finalizers, finalizerName)
            if err := r.Update(ctx, &db); err != nil {
                return ctrl.Result{}, err
            }
        }
        return ctrl.Result{}, nil
    }

    // Add finalizer if not present
    if !containsString(db.Finalizers, finalizerName) {
        db.Finalizers = append(db.Finalizers, finalizerName)
        if err := r.Update(ctx, &db); err != nil {
            return ctrl.Result{}, err
        }
    }

    // Normal reconciliation...
    return ctrl.Result{}, nil
}
```

**Key Insight**: Finalizers block deletion until cleanup is done. Any operator creating external resources MUST use finalizers.

### Pitfall 2: Infinite Reconciliation Loops

**Real Incident Report**: An operator updated the status on every reconcile. Each update triggered a new reconcile (because the object changed). The operator ran 10,000 reconciles per minute, hammering the API server and causing cluster-wide latency.

**The Anti-Pattern**:
```go
// WRONG: Updates spec on every reconcile, triggering re-reconcile
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var obj myv1.MyResource
    r.Get(ctx, req.NamespacedName, &obj)

    obj.Spec.LastReconciled = time.Now().String()  // Changes object!
    r.Update(ctx, &obj)  // Triggers another reconcile!

    return ctrl.Result{}, nil
}
```

**The Better Approach**:
```go
// RIGHT: Use status subresource, check if update needed
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var obj myv1.MyResource
    if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Do work...

    // Only update status if changed
    newStatus := computeStatus(&obj)
    if !reflect.DeepEqual(obj.Status, newStatus) {
        obj.Status = newStatus
        if err := r.Status().Update(ctx, &obj); err != nil {
            return ctrl.Result{}, err
        }
    }

    return ctrl.Result{}, nil
}

// Also: Use predicates to filter updates
func (r *MyReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&myv1.MyResource{}).
        WithEventFilter(predicate.GenerationChangedPredicate{}).  // Ignore status-only updates
        Complete(r)
}
```

**Key Insight**: Status updates don't increment Generation, so `GenerationChangedPredicate` prevents status-triggered reconciles.

### Pitfall 3: Not Setting Owner References

**Real Incident Report**: An operator created ConfigMaps for each CRD but didn't set owner references. When CRDs were deleted, the ConfigMaps remained. After months, there were thousands of orphaned ConfigMaps consuming etcd storage and making debugging harder.

**The Anti-Pattern**:
```go
// WRONG: No owner reference - ConfigMap orphaned on parent delete
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "config-for-" + req.Name,
            Namespace: req.Namespace,
        },
        Data: map[string]string{"key": "value"},
    }
    r.Create(ctx, cm)  // Orphaned when parent deleted!
    return ctrl.Result{}, nil
}
```

**The Better Approach**:
```go
// RIGHT: Set owner reference for automatic garbage collection
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var owner myv1.MyResource
    if err := r.Get(ctx, req.NamespacedName, &owner); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "config-for-" + req.Name,
            Namespace: req.Namespace,
        },
        Data: map[string]string{"key": "value"},
    }

    // Set owner reference - child deleted when parent deleted
    if err := ctrl.SetControllerReference(&owner, cm, r.Scheme); err != nil {
        return ctrl.Result{}, err
    }

    if err := r.Create(ctx, cm); err != nil {
        if !errors.IsAlreadyExists(err) {
            return ctrl.Result{}, err
        }
    }

    return ctrl.Result{}, nil
}
```

**Key Insight**: Owner references enable Kubernetes garbage collection. Child resources are automatically deleted when the owner is deleted.

### Pitfall 4: Poor Error Handling and Requeue Logic

**Real Incident Report**: An operator failed to create an S3 bucket due to a transient AWS error. It didn't retry - just left the resource in a broken state. Users had to delete and recreate to recover. Meanwhile, logs were flooded with the same error every reconcile.

**The Anti-Pattern**:
```go
// WRONG: Errors ignored, no retry, bad status updates
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // ...

    if err := r.createS3Bucket(ctx); err != nil {
        log.Error(err, "failed to create bucket")
        return ctrl.Result{}, nil  // Drops error, won't retry!
    }

    return ctrl.Result{}, nil
}
```

**The Better Approach**:
```go
// RIGHT: Proper error handling and requeue
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var obj myv1.MyResource
    if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Track state in status
    if err := r.createS3Bucket(ctx, &obj); err != nil {
        // Update status with error
        obj.Status.State = "Error"
        obj.Status.Message = err.Error()
        r.Status().Update(ctx, &obj)

        // Transient error? Requeue with backoff
        if isTransient(err) {
            return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
        }

        // Permanent error? Don't requeue, but record event
        r.Recorder.Event(&obj, corev1.EventTypeWarning, "CreateFailed", err.Error())
        return ctrl.Result{}, nil  // Don't return error for permanent failures
    }

    obj.Status.State = "Ready"
    obj.Status.Message = ""
    r.Status().Update(ctx, &obj)

    return ctrl.Result{}, nil
}
```

**Key Insight**: Return errors for automatic requeue, use `RequeueAfter` for controlled backoff, and update status so users know what's happening.

### Pitfall 5: Not Handling Concurrent Modifications

**Real Incident Report**: Two replicas of an operator tried to reconcile the same resource simultaneously. One updated the spec, then the other's update failed with a conflict. The operator didn't handle conflicts, causing reconciliation to break.

**The Anti-Pattern**:
```go
// WRONG: No conflict handling
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var obj myv1.MyResource
    r.Get(ctx, req.NamespacedName, &obj)

    // ... long operation ...

    obj.Status.LastUpdated = time.Now().String()
    r.Status().Update(ctx, &obj)  // Conflict if object changed!

    return ctrl.Result{}, nil
}
```

**The Better Approach**:
```go
// RIGHT: Handle conflicts with retry
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
        var obj myv1.MyResource
        if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
            return err
        }

        // Compute new state
        obj.Status.LastUpdated = time.Now().String()

        return r.Status().Update(ctx, &obj)
    })

    if err != nil {
        return ctrl.Result{}, err
    }

    return ctrl.Result{}, nil
}

// Or use Patch instead of Update
func (r *MyReconciler) updateStatus(ctx context.Context, obj *myv1.MyResource) error {
    patch := client.MergeFrom(obj.DeepCopy())
    obj.Status.State = "Ready"
    return r.Status().Patch(ctx, obj, patch)
}
```

**Key Insight**: Optimistic concurrency means conflicts happen. Handle them with retries or use Patch for atomic updates.

### Quick Reference: Operator Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Missing finalizers | Orphaned cloud resources | Add finalizer before creating external resources |
| Infinite reconcile loop | 10K reconciles/min | Use status subresource, GenerationChangedPredicate |
| No owner references | Orphaned Kubernetes resources | SetControllerReference for children |
| Poor error handling | Stuck resources, no retry | Return errors, RequeueAfter, status updates |
| No conflict handling | Updates fail randomly | RetryOnConflict or use Patch |
| No status updates | Users don't know what's happening | Always update status with state and message |

---

### Junior → FAANG: Operator Pitfalls as a Pre-Production Review Checklist

The pitfalls in this list map directly to a pre-production review checklist for operators. Before shipping any operator to a production cluster, verify: does the operator use finalizers for any external state it creates? Is the reconcile function idempotent (can it be called twice with the same input and produce the same result)? Does it handle the case where the custom resource is deleted before the reconcile is complete? Does it update the status subresource with meaningful conditions after each reconcile?

The most consequential pitfall for operations is non-idempotent reconcile logic. An operator that creates a duplicate cloud resource on every reconcile (instead of checking for existence first) can generate unexpected costs and causes complex cleanup scenarios. Always use `CreateOrUpdate` patterns and existence checks before creating external resources.

### Senior @ FAANG: Operator Pitfalls as Architecture Debt Indicators

At staff level, the presence of these pitfalls in a production operator is a reliability risk that needs to be quantified and remediated on a documented timeline. Orphaned resources (from missing finalizer handling) accumulate silently until they cause quota exhaustion or billing surprises. Non-idempotent reconcile logic causes resource duplication under normal Kubernetes lifecycle events (node failure, pod restart, leader election transition).

The remediation approach for each pitfall should be prioritized by impact: finalizer issues and non-idempotency cause the most severe production failures and should be fixed immediately. Missing status conditions and poor error handling are operational quality issues that should be addressed in the next planned operator release.

For organizational operator governance, the pitfall table should be encoded as a set of code review guidelines or automated linting rules. An operator code review checklist that every operator PR must satisfy, enforced by a review template, converts individual knowledge of pitfalls into organizational standards that persist regardless of team composition changes.
