# Chapter 112C: Modern Authentication with Passkeys, WebAuthn & Zero-Trust

> *"Passwords are a shared secret between you and every attacker who has ever breached a database. Passkeys share nothing."*

The password is dying. After three decades of failed attempts to train users into good password hygiene, the industry has collectively pivoted to a fundamentally different model: asymmetric cryptography in the user's own device. WebAuthn and FIDO2 define the protocols that make this possible: the browser or OS generates a public/private key pair, the private key never leaves the secure enclave of the device, and authentication is proven by signing a server challenge. The result is a credential that is phishing-proof by design, immune to server-side database breaches, and frictionless for the user through biometrics like Touch ID or Windows Hello.

Passkeys extend this model further: synced credentials backed by the user's iCloud Keychain, Google Password Manager, or 1Password vault, allowing the same phishing-resistant authentication across all of a user's devices without requiring hardware security keys. Apple, Google, and Microsoft all shipped passkey support in 2022-2023, and major platforms including GitHub, PayPal, Shopify, and Docusign have deployed passkey authentication for hundreds of millions of users. The Go ecosystem has solid WebAuthn libraries, and the server-side ceremony fits naturally into idiomatic Go HTTP handlers.

This chapter implements the complete WebAuthn authentication lifecycle in Go: registration (creating and storing a credential), authentication (verifying a signed challenge), and the full UX story including fallback flows and account recovery. Beyond passkeys, you will implement TOTP-based MFA with backup codes, hardware security key support, adaptive risk-based authentication that escalates factors based on anomaly signals, and zero-trust session management with continuous verification, all following FIDO Alliance guidance.

**What you'll learn in this chapter:**

- WebAuthn/FIDO2 protocol internals: authenticator data, attestation objects, and the credential public key structure
- Implementing passkey registration and authentication ceremonies in Go using `go-webauthn/webauthn`
- Biometric authentication flows and how the browser/OS mediates access to the secure enclave
- TOTP multi-factor authentication with QR code provisioning, backup codes, and rate-limited verification
- Hardware security key (YubiKey) support via FIDO2 resident credentials
- Risk-based and adaptive MFA: triggering step-up authentication on anomalous signals (new device, unusual location)
- Zero-trust session management: short-lived sessions, continuous re-verification, and revocation on anomaly detection
- Magic link and SMS OTP implementations with secure token generation and expiry

**Why this matters at scale:**

GitHub's mandatory 2FA rollout across all code contributors, documented on their blog, is the largest published account-security migration in developer tooling, with passkeys among the supported factors. Industry-wide, passkey rollouts consistently cut authentication support tickets while eliminating credential stuffing as an attack vector for the accounts that adopt them. Cloudflare mandates hardware security keys for all employees and has publicly credited FIDO2 with stopping a targeted phishing campaign that defeated OTP-based MFA at other companies. These are not theoretical security gains, they are measurable production outcomes from the exact technologies you will implement in this chapter.

**Prerequisites:** [Chapter 112: Authentication & Authorization Deep Dive](../chapter-112-auth-authz/00-introduction.md), [Chapter 112B: OAuth 2.0 & OIDC Complete Implementation Guide](../chapter-112b-oauth-oidc-complete/00-introduction.md), public-key cryptography fundamentals ([Chapter 108](../chapter-108-cryptography/00-introduction.md)), and a local Go 1.27.1+ toolchain.

---
