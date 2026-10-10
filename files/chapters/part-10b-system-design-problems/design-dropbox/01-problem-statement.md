## Problem Statement

Dropbox is a cloud file storage and synchronization service that lets users store files on remote servers and keep them automatically synchronized across all their devices. The core engineering challenge is not just storing files, it is doing so efficiently by transferring only the parts of a file that changed, resolving conflicts when multiple devices edit the same file, and keeping every device up to date in near-real-time. Understanding these requirements upfront helps you make the right architectural decisions throughout the design.

Design Dropbox supporting:
- 700M registered users, 500M GB of data stored
- File sync across devices in near-real-time
- Delta sync: only upload/download changed blocks
- Shared folders and collaboration
- File versioning (30-day history)
- Conflict resolution for concurrent edits
- Offline access with sync on reconnect
- 99.99% availability, strong durability

---
