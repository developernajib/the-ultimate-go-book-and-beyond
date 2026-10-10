## 112C.10 Interview Questions

**Q: How does WebAuthn prevent phishing attacks that traditional passwords and TOTP cannot?**

**What FAANG expects:** Origin binding, and knowing which party enforces it. The browser refuses to invoke an authenticator unless the requested `rpId` is a registrable suffix of the calling page's origin, so a phishing domain never gets an assertion in the first place. The authenticator itself never sees the origin. It signs over authenticator data (carrying the SHA-256 `rpIdHash`) plus a hash of the client data (carrying the real origin), and the server re-verifies both rather than trusting the browser. Passwords and TOTP are phishable because the user types them and a proxy can relay. Bonus for naming `go-webauthn/webauthn` (the maintained successor to the archived `duo-labs/webauthn`, conformance-tested against the FIDO2 test suite) and for calling out that passkeys are WebAuthn discoverable credentials synced across devices via iCloud Keychain / Google Password Manager / 1Password.

A: WebAuthn binds every credential to a specific relying party ID, and the private key never leaves the authenticator. When a page calls `navigator.credentials.get()`, the browser checks that the requested `rpId` is a registrable suffix of the page's own origin and rejects the call outright otherwise. So a user tricked into visiting `evil-example.com` cannot produce an assertion for `example.com`: the phishing page's request dies in the browser before any authenticator is touched. The signed response still carries the `rpIdHash` and the client data origin, which the server verifies independently, so a compromised or patched client cannot forge the binding either. With passwords and TOTP, the user types credentials that the phishing site can immediately relay.

**Q: What is the difference between discoverable credentials (resident keys) and server-side credentials in WebAuthn?**

A: Discoverable credentials (resident keys) store the credential ID and user handle on the authenticator itself, enabling a true passwordless flow, because the authenticator can list available credentials without the server sending `allowCredentials`. Server-side credentials require the relying party to provide `allowCredentials` containing valid credential IDs, which means the user must identify themselves first (defeating passwordless). Passkeys are always discoverable credentials.

**Q: Why is Argon2id preferred over bcrypt or PBKDF2 for password hashing?**

**What FAANG expects:** Memory-hardness defeats GPU/ASIC parallelism. bcrypt has fixed 4KB memory + 72-byte input limit. PBKDF2 is CPU-only. Argon2id is the hybrid (data-dependent + data-independent) recommended by OWASP and the 2015 Password Hashing Competition winner. Know which body says what: OWASP's baseline is m=19MiB, t=2, p=1, while RFC 9106's first recommended option is the heavier m=64MiB, t=3, p=4. Both are floors to be tuned upward against your own hardware budget. Bonus for naming `golang.org/x/crypto/argon2` as the Go stdlib-adjacent implementation.

A: Argon2id is memory-hard, so it requires significant RAM to compute, which makes GPU/ASIC attacks expensive. Bcrypt has a fixed 4KB memory usage and a maximum input length of 72 bytes. Modern GPUs can parallelize bcrypt efficiently. PBKDF2 is purely CPU-bound with no memory hardness. Argon2id (the hybrid version) also has side-channel resistance. OWASP's Argon2id baseline is m=19MiB, t=2, p=1, and RFC 9106 recommends m=64MiB, t=3, p=4 where the memory budget allows it. Candidates who quote one set of numbers as "the" parameters, or attribute the RFC 9106 figures to OWASP, are repeating a very common mix-up.

**Q: What is continuous verification in zero-trust architecture?**

A: Continuous verification means that authentication is not a one-time event at login. Instead, every access request is verified based on current context: user identity, device posture, network location, behavioral patterns, and risk signals. Sessions can be downgraded or terminated at any point if risk increases, for example if the IP changes to a known bad address mid-session. This contrasts with traditional perimeter security where a once-authenticated user is trusted until logout.

---
