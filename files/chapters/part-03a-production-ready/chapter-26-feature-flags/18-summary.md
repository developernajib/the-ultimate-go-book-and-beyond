## Summary

Feature flags decouple deployment from release, giving teams the ability to ship code to production without activating it and to control exactly who sees new behavior. Combined with proper configuration management, they form the foundation of safe, continuous delivery.

Key points from this chapter:

1. **12-Factor Configuration**: Store all environment-varying values in environment variables, never in code. Fail fast at startup when required variables are missing.
2. **Configuration Libraries**: Viper handles multi-source merging (files, env vars, defaults) for complex setups. `envconfig` covers simpler env-only needs with struct tags.
3. **Feature Flags**: Use consistent hashing for percentage rollouts so users see stable experiences. Layer targeting rules for fine-grained control by country, platform, plan, or custom attributes.
4. **Hot Reload**: Watch configuration files with `fsnotify` or poll remote sources on a timer to update flag state at runtime without restarts.
5. **Validation**: Collect all validation errors at startup and surface them in a single message rather than forcing repeated restart cycles.
6. **Secrets Management**: Use HashiCorp Vault or cloud-native secret stores for production secrets. Implement a `Secret` type with redacted `String()` and `MarshalJSON()` methods to prevent accidental logging.
7. **Flag Lifecycle**: Tag flags with expiration dates and owners. Run automated cleanup reports to prevent stale flag accumulation.
8. **Experimentation**: Build on top of feature flags with sticky variant assignment, exposure tracking, and statistical analysis to make data-driven feature decisions.

### For the Senior-at-FAANG Track

Every significant feature goes behind a flag. Every flag has an owner and lifetime. Review flag changes carefully.

### For the Staff and Principal Track

Flag governance: tagging, ownership, cleanup. Prevent debt accumulation. Decide build vs buy. Track flag metrics (count, age, stale count) as engineering health.

---
