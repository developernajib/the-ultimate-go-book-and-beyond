## Search and Discovery

Search is essential for users to find other people, posts, and trending topics on the platform. We use Elasticsearch because it provides fast full-text search with features like fuzzy matching (catching typos), field boosting (prioritizing username matches over bio matches), and aggregations (computing trending hashtags). The search service indexes user and post data into Elasticsearch whenever new content is created, and then queries Elasticsearch when users perform searches. The actual user and post objects are still fetched from PostgreSQL to ensure the response always contains the most up-to-date data.

### Elasticsearch Integration
Elasticsearch provides a distributed search engine accessible through a REST API and JSON query DSL, eliminating the need to build index infrastructure from scratch. This integration layer maps the application's internal query model to Elasticsearch's native query format and handles response parsing.

```go
// internal/service/search.go
package service

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"

    "github.com/elastic/go-elasticsearch/v8"
    "github.com/google/uuid"
    "github.com/yourname/socialnet/internal/domain"
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
```

### Junior → FAANG: Search and Discovery Fundamentals

Junior engineers often treat search as "run a SQL LIKE query." The prerequisite gap is not understanding why that fails at any meaningful scale and what an inverted index solves. Before you interview at mid-level, understand that full-text search requires tokenization, stemming, and relevance scoring. A LIKE query has no concept of relevance - every match is equal.

Start by understanding what Elasticsearch actually is: a distributed document store built on Lucene that provides a REST API over an inverted index. Know the difference between a match query (analyzed, relevance scored) and a term query (exact, not analyzed). Confusing these in an interview is a red flag for mid-level candidates.

A common first-job mistake: indexing documents synchronously in the request path. When a user creates a post, your handler calls Elasticsearch directly and waits. If Elasticsearch is slow or unavailable, the post creation fails. The correct pattern is to persist to your source of truth (PostgreSQL) first, then publish a domain event. A separate consumer updates the search index. Post creation succeeds even if the indexer lags.

Entry-level interview habit: when drawing a search system, always label which data store is the source of truth and which is the derived index. Elasticsearch is always derived. You can rebuild it from PostgreSQL. The inverse is not true.

### Senior @ FAANG: Search Platform Governance and Relevance Engineering

At FAANG scale, search is a product with its own quality metrics, a dedicated engineering team, and a governance model for which teams can index which data. The staff-level framing shifts from "how do I make search work" to "how do I make search measurably better and prevent regressions."

**Relevance as an engineering discipline.** At L6, relevance is not a single tunable constant. It is a model evaluated against a labeled judgment dataset. The process is: collect user interaction signals (clicks, dwell time, skips), label a query-document set with human raters using a scale (perfect, excellent, good, bad, irrelevant), run offline evaluation using NDCG (Normalized Discounted Cumulative Gain) against the labeled set, then run A/B tests for any ranking change before promoting to production. Shipping a ranking change without this pipeline is a bar-raiser flag at senior interviews because it means you cannot detect quality regressions.

**Index governance.** In a multi-team platform, every team wants to index their data for search. Without governance, you get dozens of Elasticsearch indices with inconsistent field naming, overlapping data, and uncoordinated mapping changes. The platform approach is to define an index schema registry: teams propose mappings through a code review process, schema changes are versioned, and breaking changes (removing a field, changing a field type) require a migration path using index aliases and reindexing rather than in-place mutation.

**Reindexing without downtime.** Mapping changes in Elasticsearch cannot be applied to existing indices. The production pattern is: create a new index with the updated mapping, reindex data from the old index to the new index using the Reindex API or an offline pipeline, run dual writes to both indices during the transition period, run search queries against both and compare results, then cut over by updating the alias to point to the new index. Documenting this process in an ADR prevents teams from attempting in-place mapping changes and corrupting production data.

**Query latency SLOs and degradation strategy.** Define p50, p95, and p99 latency SLOs for search queries per query type. Complex boolean queries over large corpora will always have higher tail latency than simple match queries. The senior engineer's responsibility is to define query complexity budgets: prohibit unbounded wildcard queries at the API layer, require pagination with a max page size, and implement query timeout at the Elasticsearch level with a fallback to a simpler backup query rather than returning an error. Returning degraded results is better than returning nothing for search.

**Discovery beyond search.** Senior engineers distinguish search (user expresses intent via a query) from discovery (system surfaces content without an explicit query). Discovery requires collaborative filtering or content-based recommendation models, not just an inverted index. At staff level, the architectural decision is whether to build discovery in-process with the search service or as a separate recommendation service with its own data pipeline. The separation is justified when the teams, data, and scaling characteristics diverge. Document that decision in an ADR with the cost-benefit analysis.
