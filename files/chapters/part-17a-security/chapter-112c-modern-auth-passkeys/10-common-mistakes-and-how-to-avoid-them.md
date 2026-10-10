## 112C.9 Common Mistakes and How to Avoid Them

| Mistake | Problem | Solution |
|---------|---------|----------|
| Using SMS OTP as sole MFA factor | SIM swap attacks bypass SMS | Offer TOTP or WebAuthn, treat SMS as weakest factor |
| Storing TOTP secrets in plaintext | Database breach exposes all TOTP secrets | Encrypt TOTP secrets at rest using application-layer encryption |
| Allowing TOTP code reuse | TOTP replay attacks within 30s window | Track recently used codes in cache, reject reuse |
| Not implementing WebAuthn resident keys | Requires username for authentication | Use `ResidentKeyRequirementRequired` for true passwordless |
| Ignoring sign count in WebAuthn | Cloned hardware authenticators go undetected | Persist the counter the authenticator returns and act on the library's `CloneWarning`. Synced passkeys report 0 and support no clone detection, so never hard-fail on a zero counter |
| Using SHA-1 for password hashing | Weak, rainbow tables exist | Use Argon2id with OWASP-recommended parameters |
| Not implementing account lockout | Unlimited brute force attempts | Rate limit by IP and username, use exponential backoff |
| Hardcoding risk thresholds | Cannot tune without deployment | Make all thresholds configurable via feature flags |
| Skipping HIBP check on registration | Users register known-breached passwords | Check HIBP on registration and password changes |
| Not supporting backup codes for MFA | Users locked out if device is lost | Always provide backup codes, allow re-generation |

---
