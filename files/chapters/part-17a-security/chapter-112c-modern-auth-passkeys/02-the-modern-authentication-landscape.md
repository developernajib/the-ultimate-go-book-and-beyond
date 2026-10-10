## 112C.1 The Modern Authentication Landscape

Authentication has shifted from knowledge-based factors (passwords) to possession-based and inherence-based factors as attackers have become adept at phishing, credential stuffing, and large-scale database breaches. FIDO2 and WebAuthn represent the current industry standard, binding credentials cryptographically to a specific origin so that stolen authenticator data is useless on a different domain. Understanding this progression helps you choose the right authentication tier for your threat model and regulatory requirements.

```
┌──────────────────────────────────────────────────────────────────────┐
│                   AUTHENTICATION EVOLUTION                           │
├────────────────┬─────────────────────────────────────────────────────┤
│ Era            │ Methods & Security Level                            │
├────────────────┼─────────────────────────────────────────────────────┤
│ Password-based │ Passwords, hashed (bcrypt/argon2)                   │
│ (current)      │ Phishable, reusable, breachable                     │
├────────────────┼─────────────────────────────────────────────────────┤
│ MFA            │ TOTP (Google Auth), SMS OTP, Email OTP              │
│ (better)       │ Stops credential stuffing, all still phishable      │
├────────────────┼─────────────────────────────────────────────────────┤
│ FIDO2/WebAuthn │ Passkeys (discoverable credentials)                 │
│ (modern)       │ Phishing-proof, passwordless, origin-bound          │
├────────────────┼─────────────────────────────────────────────────────┤
│ Zero-Trust     │ Continuous verification, posture assessment         │
│ (future)       │ No implicit trust, least-privilege, always verify   │
└────────────────┴─────────────────────────────────────────────────────┘

WebAuthn Flow:
┌──────────┐    1. Get challenge     ┌──────────────┐
│  Browser │◄────────────────────────│    Server    │
│ (Client) │    2. Sign with key     │   (Relying   │
│          │────────────────────────►│    Party)    │
│          │    3. Verify signature  │              │
└──────────┘◄────────────────────────└──────────────┘
     │
     │ Private key stored in
     ▼ Authenticator (TPM/Secure Enclave/YubiKey)
```

---
