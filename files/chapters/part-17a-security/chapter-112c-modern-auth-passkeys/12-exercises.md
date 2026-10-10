## Exercises

1. **WebAuthn Full Implementation**: Build a complete WebAuthn registration and authentication flow with an HTML frontend using the WebAuthn browser API and the Go backend from this chapter.

2. **TOTP with Window Management**: Extend the TOTP service to track used codes in Redis, keyed by user and code, so a code that has been accepted once is rejected forever after. Size the TTL to cover the whole acceptance window rather than a single period: with the chapter's `Skew: 1` and a 30 second period, a code stays valid across three steps, so a 30 second TTL would let an intercepted code be replayed in the adjacent window. Expected outcome: a replay test that submits the same code twice inside the skew window and sees the second attempt rejected.

3. **Risk Score Tuning**: Implement a feedback loop where manual fraud reports adjust risk weights using a simple Bayesian update rule.

4. **Adaptive Session Management**: Build a session manager that shortens session TTL as risk score increases (e.g., low risk → 24h TTL, medium risk → 4h TTL, high risk → 30m TTL).

5. **Password to Passkey Migration**: Design a migration path where users with passwords are prompted to add a passkey, and the password is removed once the passkey has been used successfully and a grace period (say 30 days) has passed. Handle the user who enrolls a passkey and then loses the device before the password is dropped.

---
