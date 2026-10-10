## 112.12 Key Takeaways: Authentication & Authorization Principles

1. **OAuth 2.0 is the standard**: Use authorization code flow with PKCE for web/mobile, client credentials for services
2. **JWT security matters**: Use proper algorithms (RS256), validate all claims, keep tokens short-lived
3. **Choose the right authz model**: RBAC for simplicity, ABAC for flexibility, Zanzibar for scale
4. **Multi-tenancy requires discipline**: Always filter by tenant_id, use context propagation
5. **Token refresh patterns**: Implement rotation, detect token reuse, handle concurrent refreshes
6. **Defense in depth**: Combine authentication, authorization, rate limiting, and monitoring

**Production Considerations**:
- At FAANG scale, authorization checks happen billions of times per day
- Cache authorization decisions with very short TTL (1-5 minutes)
- Use distributed caching (Redis) for token validation
- Monitor authentication failures for attack patterns
- Implement gradual rollout for permission changes
- Always have audit logs for compliance (SOC2, GDPR, HIPAA)

**Interview Relevance**:
- "How would you implement OAuth 2.0?" → Explain flows, security measures (PKCE, state parameter)
- "JWT vs session cookies?" → Discuss stateless vs stateful, scalability trade-offs
- "How does Google's Zanzibar work?" → ReBAC, relationship tuples, consistency model
- "Design a multi-tenant SaaS auth system" → Tenant isolation, role propagation, billing integration

### Junior → FAANG: Auth Key Takeaways as Interview Cheat Sheet

The key takeaways at the end of this chapter are a compressed version of the most important auth knowledge for a FAANG interview. Each takeaway should trigger a complete mental model, not just a term recall.

**Gap to close:** The takeaway "OAuth 2.0 is the standard" must trigger knowledge of all four flows (Authorization Code + PKCE, Client Credentials, Device Authorization, deprecated Implicit), their use cases, and the PKCE mechanism. If it triggers only "use OAuth for login," the mental model is incomplete.

**Interview preparation:** For each takeaway, write a 3-sentence explanation: what it is, what it prevents, and what the Go implementation looks like. Practice delivering these explanations verbally. The ability to explain auth concepts clearly and concisely, without excessive hedging or tangents, is what separates L4 interview performance from L5.

### Senior @ FAANG: Auth Takeaways as an Organizational Standard

At senior level, each key takeaway is an engineering standard that you are responsible for enforcing across your organization.

**Standard documentation:** Convert each takeaway into a documented standard with: the required behavior, the rationale, the correct Go implementation pattern (code example), the incorrect implementation (what not to do), and the enforcement mechanism (SAST rule, code review checklist item, or automated test). This documentation is the reference for every engineer on the team and is linked from the auth code review checklist.

**Standard exceptions process:** Every standard needs an exceptions process for legitimate edge cases. Define: who can approve an exception, what justification is required, how the exception is documented, and when exceptions are reviewed for continued applicability. Without an exceptions process, standards are either followed rigidly (causing problems where the standard doesn't fit) or ignored informally (degrading the standard). A formal exceptions process maintains the standard while accommodating real-world complexity.

---
