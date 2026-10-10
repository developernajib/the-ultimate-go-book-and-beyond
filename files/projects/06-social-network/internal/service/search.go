// internal/service/search.go
package service

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"

    "github.com/elastic/go-elasticsearch/v8"
    "github.com/google/uuid"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/domain/repository"
    "go.uber.org/zap"
)

type SearchService struct {
    esClient *elasticsearch.Client
    userRepo repository.UserRepository
    postRepo repository.PostRepository
    logger   *zap.Logger
}

func NewSearchService(
    esClient *elasticsearch.Client,
    userRepo repository.UserRepository,
    postRepo repository.PostRepository,
    logger *zap.Logger,
) *SearchService {
    return &SearchService{
        esClient: esClient,
        userRepo: userRepo,
        postRepo: postRepo,
        logger:   logger,
    }
}

// IndexUser indexes a user document in Elasticsearch
func (s *SearchService) IndexUser(ctx context.Context, user *domain.User) error {
    doc := map[string]any{
        "id":              user.ID.String(),
        "username":        user.Username,
        "display_name":    user.DisplayName,
        "bio":             user.Bio,
        "is_verified":     user.IsVerified,
        "follower_count":  user.FollowerCount,
        "following_count": user.FollowingCount,
        "created_at":      user.CreatedAt,
    }

    data, err := json.Marshal(doc)
    if err != nil {
        return fmt.Errorf("marshal user: %w", err)
    }

    res, err := s.esClient.Index(
        "users",
        bytes.NewReader(data),
        s.esClient.Index.WithDocumentID(user.ID.String()),
        s.esClient.Index.WithContext(ctx),
        s.esClient.Index.WithRefresh("true"),
    )
    if err != nil {
        return fmt.Errorf("index user: %w", err)
    }
    defer res.Body.Close()

    if res.IsError() {
        return fmt.Errorf("elasticsearch error: %s", res.String())
    }

    s.logger.Info("user indexed",
        zap.String("user_id", user.ID.String()),
    )

    return nil
}

// IndexPost indexes a post document in Elasticsearch
func (s *SearchService) IndexPost(ctx context.Context, post *domain.Post) error {
    doc := map[string]any{
        "id":          post.ID.String(),
        "user_id":     post.UserID.String(),
        "content":     post.Content,
        "hashtags":    post.Hashtags,
        "like_count":  post.LikeCount,
        "created_at":  post.CreatedAt,
    }

    data, err := json.Marshal(doc)
    if err != nil {
        return fmt.Errorf("marshal post: %w", err)
    }

    res, err := s.esClient.Index(
        "posts",
        bytes.NewReader(data),
        s.esClient.Index.WithDocumentID(post.ID.String()),
        s.esClient.Index.WithContext(ctx),
        s.esClient.Index.WithRefresh("true"),
    )
    if err != nil {
        return fmt.Errorf("index post: %w", err)
    }
    defer res.Body.Close()

    if res.IsError() {
        return fmt.Errorf("elasticsearch error: %s", res.String())
    }

    return nil
}

// SearchUsers performs full-text search on users
func (s *SearchService) SearchUsers(ctx context.Context, query string, limit int) ([]*domain.User, error) {
    esQuery := map[string]any{
        "query": map[string]any{
            "multi_match": map[string]any{
                "query": query,
                "fields": []string{
                    "username^3", // Boost username matches
                    "display_name^2",
                    "bio",
                },
                "fuzziness": "AUTO",
            },
        },
        "size": limit,
        "sort": []map[string]any{
            {"follower_count": map[string]string{"order": "desc"}},
            {"_score": map[string]string{"order": "desc"}},
        },
    }

    var buf bytes.Buffer
    if err := json.NewEncoder(&buf).Encode(esQuery); err != nil {
        return nil, fmt.Errorf("encode query: %w", err)
    }

    res, err := s.esClient.Search(
        s.esClient.Search.WithContext(ctx),
        s.esClient.Search.WithIndex("users"),
        s.esClient.Search.WithBody(&buf),
    )
    if err != nil {
        return nil, fmt.Errorf("search users: %w", err)
    }
    defer res.Body.Close()

    if res.IsError() {
        return nil, fmt.Errorf("elasticsearch error: %s", res.String())
    }

    // Parse response
    var result struct {
        Hits struct {
            Hits []struct {
                Source struct {
                    ID string `json:"id"`
                } `json:"_source"`
            } `json:"hits"`
        } `json:"hits"`
    }

    if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("parse response: %w", err)
    }

    // Fetch full user data from database
    userIDs := make([]uuid.UUID, 0, len(result.Hits.Hits))
    for _, hit := range result.Hits.Hits {
        if id, err := uuid.Parse(hit.Source.ID); err == nil {
            userIDs = append(userIDs, id)
        }
    }

    if len(userIDs) == 0 {
        return []*domain.User{}, nil
    }

    return s.userRepo.GetByIDs(ctx, userIDs)
}

// SearchPosts performs full-text search on posts
func (s *SearchService) SearchPosts(ctx context.Context, query string, limit int) ([]*domain.Post, error) {
    esQuery := map[string]any{
        "query": map[string]any{
            "match": map[string]any{
                "content": map[string]any{
                    "query":     query,
                    "fuzziness": "AUTO",
                },
            },
        },
        "size": limit,
        "sort": []map[string]any{
            {"created_at": map[string]string{"order": "desc"}},
        },
    }

    var buf bytes.Buffer
    if err := json.NewEncoder(&buf).Encode(esQuery); err != nil {
        return nil, fmt.Errorf("encode query: %w", err)
    }

    res, err := s.esClient.Search(
        s.esClient.Search.WithContext(ctx),
        s.esClient.Search.WithIndex("posts"),
        s.esClient.Search.WithBody(&buf),
    )
    if err != nil {
        return nil, fmt.Errorf("search posts: %w", err)
    }
    defer res.Body.Close()

    if res.IsError() {
        return nil, fmt.Errorf("elasticsearch error: %s", res.String())
    }

    // Parse and fetch posts (similar to SearchUsers)
    var result struct {
        Hits struct {
            Hits []struct {
                Source struct {
                    ID string `json:"id"`
                } `json:"_source"`
            } `json:"hits"`
        } `json:"hits"`
    }

    if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("parse response: %w", err)
    }

    postIDs := make([]uuid.UUID, 0, len(result.Hits.Hits))
    for _, hit := range result.Hits.Hits {
        if id, err := uuid.Parse(hit.Source.ID); err == nil {
            postIDs = append(postIDs, id)
        }
    }

    if len(postIDs) == 0 {
        return []*domain.Post{}, nil
    }

    return s.postRepo.GetByIDs(ctx, postIDs)
}

// GetTrendingHashtags returns trending hashtags
func (s *SearchService) GetTrendingHashtags(ctx context.Context, limit int) ([]string, error) {
    esQuery := map[string]any{
        "size": 0,
        "query": map[string]any{
            "range": map[string]any{
                "created_at": map[string]any{
                    "gte": "now-24h",
                },
            },
        },
        "aggs": map[string]any{
            "trending_hashtags": map[string]any{
                "terms": map[string]any{
                    "field": "hashtags.keyword",
                    "size":  limit,
                },
            },
        },
    }

    var buf bytes.Buffer
    if err := json.NewEncoder(&buf).Encode(esQuery); err != nil {
        return nil, fmt.Errorf("encode query: %w", err)
    }

    res, err := s.esClient.Search(
        s.esClient.Search.WithContext(ctx),
        s.esClient.Search.WithIndex("posts"),
        s.esClient.Search.WithBody(&buf),
    )
    if err != nil {
        return nil, fmt.Errorf("get trending hashtags: %w", err)
    }
    defer res.Body.Close()

    if res.IsError() {
        return nil, fmt.Errorf("elasticsearch error: %s", res.String())
    }

    var result struct {
        Aggregations struct {
            TrendingHashtags struct {
                Buckets []struct {
                    Key string `json:"key"`
                } `json:"buckets"`
            } `json:"trending_hashtags"`
        } `json:"aggregations"`
    }

    if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("parse response: %w", err)
    }

    hashtags := make([]string, 0, len(result.Aggregations.TrendingHashtags.Buckets))
    for _, bucket := range result.Aggregations.TrendingHashtags.Buckets {
        hashtags = append(hashtags, bucket.Key)
    }

    return hashtags, nil
}
