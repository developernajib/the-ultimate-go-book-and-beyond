## Common Mistakes and How to Avoid Them

These are the pitfalls that candidates most frequently fall into during system design interviews for collaborative editors. Each mistake reveals a misunderstanding of how real-time collaboration works at scale. Review this list before your interview to make sure you are not making any of these errors in your design.

1. **REST polling instead of WebSocket.** Polling at 1-second intervals introduces unacceptable latency for real-time editing and generates enormous request volume. WebSocket provides sub-50ms bidirectional message delivery with a single persistent connection.
2. **Distributed OT without a serializer.** OT only works correctly when operations are applied in a globally consistent order. Without a single server serializing operations per document, you get document divergence. This is why document server stickiness is essential.
3. **Full document on every keystroke.** Sending the entire document state with each edit wastes bandwidth and defeats the purpose of operational transforms. Operations should be small deltas (retain + insert/delete) that describe only the change.
4. **No cursor/presence.** Users expect to see where other editors are typing. Missing cursor broadcasting makes the collaborative experience feel broken, even if the OT logic is correct.
5. **No operation log.** Without persisting operations, a server crash loses all edits since the last snapshot. The operation log is your WAL, it guarantees durability and enables any server to reconstruct document state.
6. **All docs treated equally.** A viral document with 50 editors generates orders of magnitude more traffic than a private doc with one user. The system needs to handle hot documents differently (dedicated resources, rate limiting on fan-out).
7. **Conflating autosave with collaboration.** Autosave (periodic full-document writes) is not the same as real-time OT. Autosave can lose concurrent edits. OT merges them. They serve different purposes.
8. **No conflict resolution semantics.** Saying "merge edits" without explaining how insert-vs-insert and insert-vs-delete are resolved leaves a critical gap. The transform function must handle every operation combination.
9. **Ignoring rich text complexity.** Plain text OT is straightforward, but rich text adds formatting attributes (bold, italic, font size) that must be tracked per character range. Formatting operations interact with text operations in non-obvious ways.
10. **No collaborative undo/redo.** Global undo (undoing the last operation regardless of author) is wrong, it would undo another user's typing. Each user needs their own undo stack, and undone operations must be transformed against subsequent ops before being applied as inverses.

---
