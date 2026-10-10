## Problem Statement

Design a photo and video sharing platform like Instagram or TikTok that supports:
- 500M daily active users
- 100M photo/video uploads per day
- 10B feed views per day
- Video streaming at 4K quality
- Algorithmic feed (TikTok-style) or chronological + social (Instagram-style)
- Stories (24h expiring content)
- Real-time likes, comments, and notifications

**Clarifying Questions to Ask:**
- Read-heavy or write-heavy? (Read-heavy: 100:1 read/write ratio)
- Consistency requirements? (Eventual consistency acceptable for likes/views)
- Global or regional? (Global with CDN)
- Video length limits? (TikTok: up to 10min, Instagram Reels: up to 3min)

---
