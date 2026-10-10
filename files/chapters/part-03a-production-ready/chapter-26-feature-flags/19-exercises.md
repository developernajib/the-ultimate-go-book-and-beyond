## Exercises

1. **Config Library**: Build a config loader that reads from YAML files, environment variables, and hardcoded defaults, merging them in priority order (env vars override file values, file values override defaults). Include typed accessors for string, int, bool, and duration fields.

2. **Feature Flags**: Implement a feature flag system with consistent-hash percentage rollout. Verify that the same user ID always receives the same flag value, and that increasing the rollout percentage from 10% to 20% only adds new users without changing existing assignments.

3. **Hot Reload**: Create a configuration system that watches a YAML file with `fsnotify` and reloads on change. Protect the in-memory config with a `sync.RWMutex` and call registered change listeners after each successful reload.

4. **Vault Integration**: Write a `VaultSecrets` wrapper that caches secrets from HashiCorp Vault's KV v2 engine. Include a `Refresh` method that re-fetches all secrets when called, and a TTL-based expiration that triggers refresh automatically.

5. **A/B Testing**: Build an A/B testing framework that assigns users to experiment variants using consistent hashing, persists assignments for stickiness, tracks exposure events, and computes a two-proportion z-test for statistical significance between control and treatment groups.

### Senior at FAANG Track

6. Audit feature flags in your service. Identify stale ones. Delete flag and associated code.

### Staff / Principal Track

7. Build flag governance: tagging, staleness detection, lint rules for dead flag references. Drive adoption.

8. Evaluate managed flag services (LaunchDarkly, Split, Optimizely). Compare to self-hosting. Recommend path for org.

9. Create flag metrics dashboard: count, age distribution, ownership distribution. Publish monthly.
