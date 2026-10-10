## Problem Statement

In a system design interview, you will typically be asked to design either YouTube (user-generated content) or Netflix (licensed content). The two platforms share many core components but diverge significantly in upload volume, transcoding strategy, and CDN architecture. Your first step should be to clarify which model the interviewer wants, then use the requirements below to scope the problem.

Design a video streaming platform that supports:
- 2B+ monthly active users (YouTube) / 300M subscribers (Netflix)
- 500 hours of video uploaded per minute (YouTube)
- 1B hours watched per day
- Adaptive bitrate streaming (240p to 4K)
- Global delivery: < 200ms to first byte from a CDN edge, < 2s to first rendered frame
- Content recommendations
- Live streaming capability (YouTube)

**Clarifying Questions to Ask in Interviews:**

1. User-generated content (YouTube model) or licensed content (Netflix)? Cover both.
2. Do we need live streaming? Start with VOD, mention live as an extension.
3. What is the play latency target? Under 200ms to first byte from the edge, under 2s to first rendered frame.
4. Do we need DRM for premium content? Yes for the Netflix model.
5. Is offline download required? Yes for mobile apps, using DRM-encrypted downloads.
6. What is the acceptable processing delay after upload? YouTube: 5 to 15 minutes. Netflix: 24 to 48 hours, because per-title encoding trades turnaround for quality per bit.

---
