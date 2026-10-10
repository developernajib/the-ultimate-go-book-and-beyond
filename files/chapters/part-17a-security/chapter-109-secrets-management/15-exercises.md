## Exercises

1. **HashiCorp Vault Dynamic Database Credentials**: Integrate a Go service with Vault's database secrets engine to obtain short-lived PostgreSQL credentials at startup instead of reading a static password from the environment. Implement a credential renewal goroutine that calls `client.Sys().Renew` on the credential lease before expiry and reconnects the `database/sql` pool transparently. Expected outcome: a service that never holds a static DB password and automatically refreshes credentials without downtime.

2. **Secret Rotation Pipeline**: Write a Go program that rotates an AWS Secrets Manager secret on a configurable schedule. The rotation logic must: generate a new random password with `crypto/rand`, update the secret value, verify the new credential by opening a real DB connection, then mark the rotation complete. Implement a rollback step that restores the previous version if the verification step fails. Expected outcome: automated rotation with zero manual intervention and safe rollback on failure.

3. **Zero-Trust Secret Access Middleware**: Build an HTTP middleware that validates requests against Vault's AppRole auth method before serving secrets. Each request must present a `role_id` and `secret_id` in headers, obtain a short-lived Vault token, fetch the requested secret path, and inject the secret into the request context. The token must never be cached longer than its TTL. Expected outcome: every HTTP request independently authenticates with Vault. No long-lived tokens held in memory.

4. **External Secrets Operator Simulation**: Implement a Go controller loop that watches a custom `ExternalSecret` CRD-like config (a JSON file listing secret name → Vault path mappings) and syncs secrets into a local encrypted key-value store. The controller must detect config changes, re-fetch updated values, and write an audit record for every sync operation. Expected outcome: a reconciliation loop that converges observed state to desired state within one polling interval of any change.

5. **Pre-commit Secret Scanner**: Write a Go binary that scans staged git diff output (piped via stdin) for high-entropy strings and known secret patterns (AWS keys, PEM headers, JWT prefixes). Return exit code 1 with a structured JSON report of any findings so it can be wired as a git pre-commit hook. Include allow-list support via a `.secretsignore` file. Expected outcome: the scanner blocks commits containing real secrets while allowing test fixtures listed in the allow-list.

6. **Encrypted Secrets Envelope**: Design a Go package that implements envelope encryption: a data key is generated with `crypto/rand`, used to AES-256-GCM encrypt the secret value, and the data key itself is encrypted with a KMS root key (stubbed with a local RSA key for testing). The package must expose `Seal` and `Open` operations and store the encrypted data key alongside the ciphertext so that rotating the root key only requires re-encrypting data keys, not re-encrypting all secret values. Expected outcome: a storage-agnostic envelope encryption library with unit tests demonstrating key rotation without re-encrypting payload data.

In the next chapter, we'll explore supply chain security, protecting the dependencies, builds, and artifacts that your Go services are made from.

### Junior → FAANG: Getting Maximum Value From Secrets Management Exercises

These exercises are production-fidelity. They are not simplified toy examples: they use real secrets managers, real rotation logic, and real envelope encryption. Completing them correctly prepares you for the most common secrets management interview questions.

**Starting point:** Begin with Exercise 1 (Vault dynamic credentials). It is the most commonly asked about in FAANG backend interviews because it demonstrates dynamic secrets, which is the key differentiator of Vault over static secrets managers. A complete solution with the credential renewal goroutine demonstrates production-level Go concurrency applied to a security problem.

**Testing discipline:** For each exercise, write the test before the implementation. For Exercise 1, the test should: start a Vault dev server in Docker, configure the database secrets engine with a local PostgreSQL container, run the Go service, verify it connects to the database, trigger a credential rotation in Vault, verify the service reconnects transparently. This integration test is more valuable than unit tests alone because it exercises the full rotation lifecycle.

### Senior @ FAANG: Exercise 6 (Envelope Encryption) as a Design Interview Proxy

Exercise 6 (encrypted secrets envelope) is a compressed version of the key management system design question that appears in L6 security interviews. Completing it correctly and being able to walk through the design demonstrates staff-level cryptographic system thinking.

**Design dimensions to be ready to discuss:** Why use envelope encryption rather than encrypting directly with the root key (data key agility: rotating the root key requires only re-wrapping data keys, not re-encrypting all data). Why store the encrypted data key alongside the ciphertext (decryption self-contained, no external lookup needed for the data key). How would you extend this to support multiple root key versions (store the key version identifier with the encrypted data key). How would you make `Seal` and `Open` concurrent-safe (each operation is stateless given its inputs, no shared mutable state). These four questions cover the dimensions that a bar-raiser would probe in an L6 design interview.

---
