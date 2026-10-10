## API Design

A well-structured API is the contract between your mobile/web clients and backend services. The endpoints below follow RESTful conventions with cursor-based pagination for infinite scroll, which is more efficient than offset-based pagination for large datasets. Each response type is defined as a Go struct to show exactly what data flows between client and server.

### REST Endpoints

The API is organized around five resource groups: uploads, feeds, interactions (likes and comments), social graph (follows), and stories. Cursor-based pagination is used everywhere because it performs consistently regardless of dataset size, unlike OFFSET/LIMIT which slows down as users scroll deeper.

```go
package api

import "time"

// ========== Upload ==========
// POST /api/v1/media/upload/initiate -> pre-signed S3 URL
// POST /api/v1/media/upload/complete -> triggers async processing

// ========== Feed ==========
// GET /api/v1/feed?cursor=abc&limit=20

type FeedResponse struct {
	Posts      []PostView `json:"posts"`
	NextCursor string     `json:"next_cursor"`
	HasMore    bool       `json:"has_more"`
}

type PostView struct {
	ID           string    `json:"id"`
	Author       UserBrief `json:"author"`
	MediaURL     string    `json:"media_url"`
	ThumbnailURL string    `json:"thumbnail_url"`
	MediaType    string    `json:"media_type"` // photo, video, story
	Caption      string    `json:"caption"`
	LikeCount    int64     `json:"like_count"`
	CommentCount int64     `json:"comment_count"`
	ViewCount    int64     `json:"view_count"`
	IsLiked      bool      `json:"is_liked"`
	CreatedAt    time.Time `json:"created_at"`
}

type UserBrief struct {
	ID         string `json:"id"`
	Username   string `json:"username"`
	AvatarURL  string `json:"avatar_url"`
	IsVerified bool   `json:"is_verified"`
}

// GET /api/v1/feed/discover?category=trending

// ========== Interactions ==========
// POST /api/v1/posts/{id}/like
// DELETE /api/v1/posts/{id}/like
// POST /api/v1/posts/{id}/comments { "text": "..." }
// GET /api/v1/posts/{id}/comments?cursor=abc

// ========== Social Graph ==========
// POST /api/v1/users/{id}/follow
// DELETE /api/v1/users/{id}/follow
// GET /api/v1/users/{id}/followers?cursor=abc
// GET /api/v1/users/{id}/profile

type UserProfile struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	Bio            string `json:"bio"`
	AvatarURL      string `json:"avatar_url"`
	FollowerCount  int64  `json:"follower_count"`
	FollowingCount int64  `json:"following_count"`
	PostCount      int64  `json:"post_count"`
	IsFollowing    bool   `json:"is_following"`
}

// ========== Stories ==========
// POST /api/v1/stories
// GET /api/v1/stories/feed

type StoryFeedResponse struct {
	StoryGroups []StoryGroup `json:"story_groups"`
}

type StoryGroup struct {
	User      UserBrief `json:"user"`
	Stories   []Story   `json:"stories"`
	HasUnseen bool      `json:"has_unseen"`
}

type Story struct {
	ID        string    `json:"id"`
	MediaURL  string    `json:"media_url"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// POST /api/v1/stories/{id}/view (records view)
// GET /api/v1/search?q=golang&type=user,hashtag
```

---
