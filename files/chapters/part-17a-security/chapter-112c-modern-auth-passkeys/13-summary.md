## Summary

Modern authentication has moved well beyond passwords:

- **WebAuthn/FIDO2** provides phishing-resistant, passwordless authentication using public key cryptography bound to the relying party's domain
- **TOTP** adds time-based second factors that work offline but are still phishable, because a relay proxy can forward a typed code, so prefer WebAuthn wherever it is available
- **Magic links** offer low-friction passwordless flow for contexts where FIDO2 isn't available
- **Risk-based authentication** dynamically adjusts requirements based on behavioral signals, device posture, and threat intelligence
- **Argon2id** with memory-hard parameters is the correct choice for password hashing when passwords must be used
- **Zero-trust continuous verification** eliminates implicit session trust, verifying every request against current context

The direction of the industry is clear: passwords are being replaced by cryptographic authenticators bound to devices. Go is well-positioned for this with excellent crypto primitives, and `go-webauthn` provides a production-ready WebAuthn implementation.

---

### Navigation & Cross-References

- **Previous Chapter:** [Chapter 112B: OAuth 2.0 & OIDC Complete Implementation Guide](../chapter-112b-oauth-oidc-complete/00-introduction.md)
- **Part Overview:** [Part XVII-A: Security](../00-part-intro.md)
- **Next Part:** [Part XVII-B: Compliance & Regulatory Engineering](../../part-17b-compliance-regulatory/00-part-intro.md)
- **Next Chapter:** [Chapter 112D: Engineering Compliance](../../part-17b-compliance-regulatory/chapter-112d-engineering-compliance/00-introduction.md)
