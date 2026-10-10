## Problem Statement

Collaborative document editing is fundamentally different from most CRUD applications because every user action (a single keystroke, a formatting change, a cursor move) must be broadcast to all other editors and applied in a way that preserves document consistency. The system cannot simply "last write wins" because two people typing in different paragraphs simultaneously are both correct, their edits must be merged without conflict. This requires a conflict resolution algorithm (OT or CRDT) running on every keystroke, a persistent WebSocket connection per editor, and a storage layer that can replay the entire edit history for recovery.

Design Google Docs supporting:
- 1 billion documents, 100M daily users
- Real-time collaborative editing (50+ simultaneous users per doc)
- Conflict-free concurrent edits (Operational Transform or CRDTs)
- Offline editing with sync on reconnect
- Document history and version control
- Comments, suggestions, and review modes
- Rich text formatting, tables, images
- Sharing and permissions (view/comment/edit)

---
