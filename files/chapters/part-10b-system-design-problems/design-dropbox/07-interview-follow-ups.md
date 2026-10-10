## Interview Follow-Ups

These are the most common follow-up questions interviewers ask after you present the core Dropbox design. Each question probes a specific edge case or operational concern that separates a surface-level answer from a production-quality one. Practice answering these concisely, you should be able to cover each in 30-60 seconds during an interview.

**Q: How do you handle conflicts when two devices edit the same file?**

Never merge silently. Conflict detection happens at commit time: if the server revision does not match the client's base revision, the commit is a conflict. The server keeps the first writer's version and saves the second writer's version alongside it as "filename (conflicted copy)", so both versions survive and the user decides. Folder operations merge additively, so folders cannot conflict.

**Q: How does deduplication work for encrypted files?**

Per-file encryption (each file has a unique random key) defeats block-level dedup, because identical plaintext produces different ciphertext under different keys. The classic answer is convergent encryption: derive the key from the content itself (key = SHA256(plaintext_block)), so identical plaintext blocks produce identical ciphertext, the same hash, and dedup still works. The trade-off is a confirmation-of-file attack: anyone who has the same plaintext can prove you store it. Production Dropbox sidesteps the problem differently, it encrypts blocks at rest with keys it manages, so dedup runs on plaintext block hashes before encryption.

**Q: How do you handle large file uploads on slow connections?**

Chunking into 4MB blocks enables resumable uploads. If upload interrupted mid-block, retry just that block. Pre-signed S3 URLs expire after 15 minutes, client requests new URLs for remaining blocks. Block immutability means already-uploaded blocks never need re-uploading.

---
