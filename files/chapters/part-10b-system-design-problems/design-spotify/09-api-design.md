## API Design

The API surface for a music streaming platform follows RESTful conventions and covers three main areas: streaming (getting audio URLs), content management (playlists, search), and playback control (player state, queue). These endpoints are what the mobile and desktop clients call to deliver the user experience. In a real system, all endpoints require authentication via OAuth2 tokens, and rate limiting protects against abuse.

```go
package api

// GET /api/v1/tracks/{id}/stream - Get streaming URLs
// GET /api/v1/search?q={query}&type=track,artist - Search
// POST /api/v1/playlists - Create playlist
// POST /api/v1/playlists/{id}/tracks - Add track
// PUT /api/v1/playlists/{id}/tracks/reorder - Reorder
// GET /api/v1/me/player - Playback state
// PUT /api/v1/me/player/play - Play
// GET /api/v1/me/recommendations - Personalized recs
// POST /api/v1/tracks/{id}/play - Record play event (royalties)
```

---
