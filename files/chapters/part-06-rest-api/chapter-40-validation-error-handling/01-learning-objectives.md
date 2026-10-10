## Learning Objectives

After completing this chapter, you will be able to:

- **Implement layered validation** with struct tags, custom validators, and business rule validation patterns used by production APIs
- **Design consistent error responses** following industry standards from Stripe, Google, and Microsoft for actionable error messages
- **Build reusable validation middleware** that handles JSON parsing errors, query validation, and path parameter validation
- **Create domain-specific error types** with proper error wrapping and mapping to HTTP status codes
- **Implement validation testing strategies** including table-driven tests and error response validation
- **Handle edge cases gracefully** including malformed JSON, oversized payloads, and content-type mismatches
- **Apply internationalization patterns** for error messages across different locales

### Junior → FAANG: what this objective list actually means on day one

Read the objectives as a checklist of concrete artifacts you should be able to produce in an interview. "Implement layered validation" means you can point at a file and say "this is the transport layer, it rejects malformed JSON with 400," then point at another file and say "this is the service layer, it rejects duplicate emails with 409." "Design consistent error responses" means you can draw the JSON envelope on a whiteboard without hesitating, including which fields are always present and which are optional. "Build reusable middleware" means you have written at least one `func(http.Handler) http.Handler` that wraps every route and you understand why the body must be read with `MaxBytesReader` before `json.Decode`. A strong junior candidate walks into the room with a GitHub repo that demonstrates each bullet.

### Senior @ FAANG: the unwritten objectives that matter more

The objectives above describe the mechanics. The staff-level objectives that hiring committees actually evaluate are unwritten. You should be able to articulate the validation boundary strategy for a service (where does parsing end, where does business logic begin, who owns each layer), defend a choice of library against the three main alternatives with trade-offs measured in engineering time and latency, and show a migration path from an ad-hoc error shape to RFC 9457 without breaking existing clients. You should be able to explain how validation failures interact with your observability stack (do 422s count against SLOs, how are they sampled, are field-level errors indexed for search) and how your error catalog evolves through deprecation cycles when a field is renamed or split. You should have a written position on whether GraphQL-style partial success is appropriate for your domain, on whether idempotency keys require validation before or after the business rule layer, and on how you handle validation in async pipelines where the producer cannot block on feedback. Finally, you should be able to sketch the contract-testing strategy that keeps client SDKs, server validators, and OpenAPI documents in sync across a fleet of polyglot services. These are the objectives a staff engineer is graded on, even when the job description only lists the bullets above.

---
