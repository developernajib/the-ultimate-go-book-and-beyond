## Follow-up Questions

These are the questions interviewers most commonly ask as follow-ups after you present your core design. Having concise answers ready for each one demonstrates depth of understanding and shows you have thought beyond the happy path. Each answer below is intentionally brief, mimicking what you would say in a time-constrained interview.

**1. Collaborative undo?** Each user maintains their own undo stack. When a user presses undo, the system computes the inverse of their last operation, transforms that inverse against all operations applied by other users since the original, and applies the transformed inverse. This ensures undoing your own insert does not affect text another user typed in the same area.

**2. Embedded objects (images, tables, drawings)?** Each embedded object is treated as a separate sub-document with its own OT engine and revision counter. The parent document references the embedded object by ID. This isolates the complexity of table cell editing or drawing operations from the text OT engine.

**3. Preventing document corruption?** Three layers of defense: server-side validation rejects malformed operations (e.g., delete at position beyond document length), rate limiting prevents a single client from overwhelming the OT engine, and permission checks on every WebSocket message ensure only authorized users can write. Additionally, periodic checksum comparison between the server's document state and a freshly reconstructed version from the op log catches any divergence.

**4. Suggesting mode (track changes)?** Suggestions are stored as a parallel layer that does not modify the actual document content. Each suggestion records the proposed operations, author, and anchor range. The document renders suggestions as colored markup. Accepting a suggestion applies its operations to the real document, rejecting discards them. This is covered in detail in the Suggestion Mode deep dive.

**5. Document export (PDF, DOCX)?** Export is handled asynchronously. The service loads the document content, converts it to HTML as an intermediate format, then uses headless Chrome for PDF rendering or Pandoc for DOCX conversion. The result is stored in S3 with a pre-signed download URL. CPU-intensive exports are queued to avoid blocking the editing path.

**6. Spell and grammar checking?** Basic spell checking uses a client-side dictionary for instant red underlines. Advanced grammar and style suggestions use a server-side ML model, invoked with a 2-second debounce per paragraph to avoid overwhelming the model with every keystroke. Results are cached per paragraph hash so unchanged text does not trigger re-analysis.

**7. Split brain (two servers think they own the same document)?** A coordination service (ZooKeeper or etcd) ensures single document ownership at all times. If a server fails, the coordination service detects it via heartbeat timeout and reassigns the document to another server within 10 seconds. During the transition, clients receive a "reconnecting" signal and buffer operations locally.

---
