## Extended Scenarios

Most system design discussions focus on the typical case, but interviewers often probe edge cases to test your depth. The scenarios below cover two extremes that a production Google Docs system must handle: documents that are unusually large (pushing memory and network limits) and documents that go viral (pushing connection and fan-out limits). Having strategies for both shows you can design systems that degrade gracefully rather than failing catastrophically.

### Handling Very Large Documents (>10MB)

For documents exceeding 10MB (e.g., a 500-page technical manual):

1. **Chunked loading**: Load only the visible portion of the document. As the user scrolls, lazy-load additional sections via WebSocket.
2. **Chunked OT**: Split the document into logical sections (chapters). Each section has its own OT engine instance. Operations only affect the section they belong to.
3. **Memory optimization**: Compress idle sections in memory using LZ4. Decompress on demand.
4. **Snapshot compression**: S3 snapshots use gzip compression (typically 5x reduction for text).

### Handling a Viral Document (50,000+ Viewers)

When a document goes viral (e.g., a breaking news document shared on social media):

1. **Read-only mode for viewers**: Only editors run through the OT engine. Viewers receive a periodically updated snapshot (every 5 seconds).
2. **CDN caching**: Viewer content served from CDN with 5-second TTL. Reduces load on doc servers by 99%.
3. **Separate viewer WebSocket**: Viewers connect to a lightweight "viewer gateway" that broadcasts snapshots, not individual operations.
4. **Automatic scaling**: When active viewer count > 1000, promote to CDN-served mode automatically.


---
