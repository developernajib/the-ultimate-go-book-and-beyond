## Social Graph Implementation

A social graph tracks who follows whom, and it is one of the most performance-critical parts of a social network. We use Neo4j, a graph database, because it can traverse relationships between users in constant time regardless of the total number of users in the system. Relational databases struggle with multi-hop queries like "find mutual followers" or "suggest friends of friends," but graph databases handle these naturally. The implementation below stores the graph in both PostgreSQL (as a backup and for simple queries) and Neo4j (for complex graph traversals and recommendations).

### Neo4j Social Graph Service

The social graph tracks directed follow relationships between users, enabling queries like "who does this user follow" and "who follows this user". Caching adjacency sets in Redis avoids expensive graph traversal queries on each feed generation request.

```go
// internal/service/graph.go
package service

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/neo4j/neo4j-go-driver/v5/neo4j"
    "go.uber.org/zap"
)

type SocialGraphService struct {
    driver neo4j.DriverWithContext
    logger *zap.Logger
}

func NewSocialGraphService(driver neo4j.DriverWithContext, logger *zap.Logger) *SocialGraphService {
    return &SocialGraphService{
        driver: driver,
        logger: logger,
    }
}

// CreateUser creates a user node in Neo4j
func (s *SocialGraphService) CreateUser(ctx context.Context, userID uuid.UUID, username string) error {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
    defer session.Close(ctx)

    query := `
        MERGE (u:User {id: $id})
        ON CREATE SET u.username = $username, u.created_at = datetime()
        ON MATCH SET u.username = $username
    `

    _, err := session.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "id":       userID.String(),
            "username": username,
        })
        if err != nil {
            return nil, err
        }
        return result.Consume(ctx)
    })

    return err
}

// Follow creates a follow relationship
func (s *SocialGraphService) Follow(ctx context.Context, followerID, followeeID uuid.UUID) error {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
    defer session.Close(ctx)

    query := `
        MATCH (follower:User {id: $follower_id})
        MATCH (followee:User {id: $followee_id})
        MERGE (follower)-[f:FOLLOWS]->(followee)
        ON CREATE SET f.created_at = datetime()
        RETURN f
    `

    _, err := session.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "follower_id": followerID.String(),
            "followee_id": followeeID.String(),
        })
        if err != nil {
            return nil, err
        }
        return result.Consume(ctx)
    })

    if err != nil {
        return fmt.Errorf("follow user: %w", err)
    }

    s.logger.Info("user followed",
        zap.String("follower_id", followerID.String()),
        zap.String("followee_id", followeeID.String()),
    )

    return nil
}

// Unfollow removes a follow relationship
func (s *SocialGraphService) Unfollow(ctx context.Context, followerID, followeeID uuid.UUID) error {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
    defer session.Close(ctx)

    query := `
        MATCH (follower:User {id: $follower_id})-[f:FOLLOWS]->(followee:User {id: $followee_id})
        DELETE f
    `

    _, err := session.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "follower_id": followerID.String(),
            "followee_id": followeeID.String(),
        })
        if err != nil {
            return nil, err
        }
        return result.Consume(ctx)
    })

    if err != nil {
        return fmt.Errorf("unfollow user: %w", err)
    }

    s.logger.Info("user unfollowed",
        zap.String("follower_id", followerID.String()),
        zap.String("followee_id", followeeID.String()),
    )

    return nil
}

// GetFollowers returns list of follower user IDs
func (s *SocialGraphService) GetFollowers(ctx context.Context, userID uuid.UUID, limit, offset int) ([]uuid.UUID, error) {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)

    query := `
        MATCH (follower:User)-[:FOLLOWS]->(u:User {id: $user_id})
        RETURN follower.id AS id
        ORDER BY follower.username
        SKIP $offset
        LIMIT $limit
    `

    result, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "user_id": userID.String(),
            "limit":   limit,
            "offset":  offset,
        })
        if err != nil {
            return nil, err
        }

        var ids []uuid.UUID
        for result.Next(ctx) {
            record := result.Record()
            idStr, _ := record.Get("id")
            if id, err := uuid.Parse(idStr.(string)); err == nil {
                ids = append(ids, id)
            }
        }

        return ids, result.Err()
    })

    if err != nil {
        return nil, fmt.Errorf("get followers: %w", err)
    }

    return result.([]uuid.UUID), nil
}

// GetFollowing returns list of followee user IDs
func (s *SocialGraphService) GetFollowing(ctx context.Context, userID uuid.UUID, limit, offset int) ([]uuid.UUID, error) {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)

    query := `
        MATCH (u:User {id: $user_id})-[:FOLLOWS]->(followee:User)
        RETURN followee.id AS id
        ORDER BY followee.username
        SKIP $offset
        LIMIT $limit
    `

    result, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "user_id": userID.String(),
            "limit":   limit,
            "offset":  offset,
        })
        if err != nil {
            return nil, err
        }

        var ids []uuid.UUID
        for result.Next(ctx) {
            record := result.Record()
            idStr, _ := record.Get("id")
            if id, err := uuid.Parse(idStr.(string)); err == nil {
                ids = append(ids, id)
            }
        }

        return ids, result.Err()
    })

    if err != nil {
        return nil, fmt.Errorf("get following: %w", err)
    }

    return result.([]uuid.UUID), nil
}

// IsFollowing checks if follower follows followee
func (s *SocialGraphService) IsFollowing(ctx context.Context, followerID, followeeID uuid.UUID) (bool, error) {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)

    query := `
        MATCH (follower:User {id: $follower_id})-[:FOLLOWS]->(followee:User {id: $followee_id})
        RETURN COUNT(*) > 0 AS is_following
    `

    result, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "follower_id": followerID.String(),
            "followee_id": followeeID.String(),
        })
        if err != nil {
            return false, err
        }

        if result.Next(ctx) {
            record := result.Record()
            isFollowing, _ := record.Get("is_following")
            return isFollowing.(bool), nil
        }

        return false, result.Err()
    })

    if err != nil {
        return false, fmt.Errorf("check is following: %w", err)
    }

    return result.(bool), nil
}

// GetMutualFollowers returns users who follow both user1 and user2
func (s *SocialGraphService) GetMutualFollowers(ctx context.Context, user1ID, user2ID uuid.UUID, limit int) ([]uuid.UUID, error) {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)

    query := `
        MATCH (u1:User {id: $user1_id})<-[:FOLLOWS]-(mutual:User)-[:FOLLOWS]->(u2:User {id: $user2_id})
        RETURN mutual.id AS id
        LIMIT $limit
    `

    result, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "user1_id": user1ID.String(),
            "user2_id": user2ID.String(),
            "limit":    limit,
        })
        if err != nil {
            return nil, err
        }

        var ids []uuid.UUID
        for result.Next(ctx) {
            record := result.Record()
            idStr, _ := record.Get("id")
            if id, err := uuid.Parse(idStr.(string)); err == nil {
                ids = append(ids, id)
            }
        }

        return ids, result.Err()
    })

    if err != nil {
        return nil, fmt.Errorf("get mutual followers: %w", err)
    }

    return result.([]uuid.UUID), nil
}

// GetRecommendations returns friend-of-friend recommendations
func (s *SocialGraphService) GetRecommendations(ctx context.Context, userID uuid.UUID, limit int) ([]uuid.UUID, error) {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)

    query := `
        MATCH (u:User {id: $user_id})-[:FOLLOWS]->(friend:User)-[:FOLLOWS]->(recommendation:User)
        WHERE NOT (u)-[:FOLLOWS]->(recommendation) AND u <> recommendation
        WITH recommendation, COUNT(*) AS mutual_friends
        RETURN recommendation.id AS id, mutual_friends
        ORDER BY mutual_friends DESC
        LIMIT $limit
    `

    result, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "user_id": userID.String(),
            "limit":   limit,
        })
        if err != nil {
            return nil, err
        }

        var ids []uuid.UUID
        for result.Next(ctx) {
            record := result.Record()
            idStr, _ := record.Get("id")
            if id, err := uuid.Parse(idStr.(string)); err == nil {
                ids = append(ids, id)
            }
        }

        return ids, result.Err()
    })

    if err != nil {
        return nil, fmt.Errorf("get recommendations: %w", err)
    }

    return result.([]uuid.UUID), nil
}

// GetShortestPath finds the shortest path between two users
func (s *SocialGraphService) GetShortestPath(ctx context.Context, user1ID, user2ID uuid.UUID) ([]uuid.UUID, error) {
    session := s.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)

    query := `
        MATCH path = shortestPath(
            (u1:User {id: $user1_id})-[:FOLLOWS*]-(u2:User {id: $user2_id})
        )
        RETURN [node IN nodes(path) | node.id] AS path_ids
    `

    result, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
        result, err := tx.Run(ctx, query, map[string]any{
            "user1_id": user1ID.String(),
            "user2_id": user2ID.String(),
        })
        if err != nil {
            return nil, err
        }

        if result.Next(ctx) {
            record := result.Record()
            pathIDs, _ := record.Get("path_ids")
            idStrings := pathIDs.([]any)

            var ids []uuid.UUID
            for _, idStr := range idStrings {
                if id, err := uuid.Parse(idStr.(string)); err == nil {
                    ids = append(ids, id)
                }
            }

            return ids, nil
        }

        return []uuid.UUID{}, result.Err()
    })

    if err != nil {
        return nil, fmt.Errorf("get shortest path: %w", err)
    }

    return result.([]uuid.UUID), nil
}
```

### Combined Follow Service (PostgreSQL + Neo4j)

The Follow Service coordinates between PostgreSQL and Neo4j to keep both data stores in sync. When a user follows someone, the service writes to PostgreSQL first (as the source of truth), updates follower and following counters, and then asynchronously replicates the relationship to Neo4j. This dual-write approach gives you the transactional safety of PostgreSQL for basic operations and the graph traversal power of Neo4j for recommendations and mutual follower queries.

```go
// internal/service/follow.go
package service

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/yourname/socialnet/internal/domain/repository"
    "go.uber.org/zap"
)

type FollowService struct {
    followRepo  repository.FollowRepository
    userRepo    repository.UserRepository
    graphService *SocialGraphService
    logger      *zap.Logger
}

func NewFollowService(
    followRepo repository.FollowRepository,
    userRepo repository.UserRepository,
    graphService *SocialGraphService,
    logger *zap.Logger,
) *FollowService {
    return &FollowService{
        followRepo:   followRepo,
        userRepo:     userRepo,
        graphService: graphService,
        logger:       logger,
    }
}

func (s *FollowService) Follow(ctx context.Context, followerID, followeeID uuid.UUID) error {
    // Check if users exist
    if _, err := s.userRepo.GetByID(ctx, followerID); err != nil {
        return fmt.Errorf("follower not found: %w", err)
    }

    if _, err := s.userRepo.GetByID(ctx, followeeID); err != nil {
        return fmt.Errorf("followee not found: %w", err)
    }

    // Create follow in PostgreSQL
    if err := s.followRepo.Create(ctx, followerID, followeeID); err != nil {
        return fmt.Errorf("create follow: %w", err)
    }

    // Update counters
    if err := s.userRepo.IncrementFollowerCount(ctx, followeeID, 1); err != nil {
        s.logger.Error("failed to increment follower count", zap.Error(err))
    }

    if err := s.userRepo.IncrementFollowingCount(ctx, followerID, 1); err != nil {
        s.logger.Error("failed to increment following count", zap.Error(err))
    }

    // Create follow in Neo4j (async for performance)
    go func() {
        ctx := context.Background()
        if err := s.graphService.Follow(ctx, followerID, followeeID); err != nil {
            s.logger.Error("failed to create follow in neo4j",
                zap.String("follower_id", followerID.String()),
                zap.String("followee_id", followeeID.String()),
                zap.Error(err),
            )
        }
    }()

    s.logger.Info("user followed",
        zap.String("follower_id", followerID.String()),
        zap.String("followee_id", followeeID.String()),
    )

    return nil
}

func (s *FollowService) Unfollow(ctx context.Context, followerID, followeeID uuid.UUID) error {
    // Delete follow from PostgreSQL
    if err := s.followRepo.Delete(ctx, followerID, followeeID); err != nil {
        return fmt.Errorf("delete follow: %w", err)
    }

    // Update counters
    if err := s.userRepo.IncrementFollowerCount(ctx, followeeID, -1); err != nil {
        s.logger.Error("failed to decrement follower count", zap.Error(err))
    }

    if err := s.userRepo.IncrementFollowingCount(ctx, followerID, -1); err != nil {
        s.logger.Error("failed to decrement following count", zap.Error(err))
    }

    // Delete follow from Neo4j (async)
    go func() {
        ctx := context.Background()
        if err := s.graphService.Unfollow(ctx, followerID, followeeID); err != nil {
            s.logger.Error("failed to delete follow in neo4j",
                zap.String("follower_id", followerID.String()),
                zap.String("followee_id", followeeID.String()),
                zap.Error(err),
            )
        }
    }()

    s.logger.Info("user unfollowed",
        zap.String("follower_id", followerID.String()),
        zap.String("followee_id", followeeID.String()),
    )

    return nil
}

func (s *FollowService) GetFollowers(ctx context.Context, userID uuid.UUID, limit, offset int) ([]uuid.UUID, error) {
    return s.graphService.GetFollowers(ctx, userID, limit, offset)
}

func (s *FollowService) GetFollowing(ctx context.Context, userID uuid.UUID, limit, offset int) ([]uuid.UUID, error) {
    return s.graphService.GetFollowing(ctx, userID, limit, offset)
}

func (s *FollowService) IsFollowing(ctx context.Context, followerID, followeeID uuid.UUID) (bool, error) {
    return s.graphService.IsFollowing(ctx, followerID, followeeID)
}

func (s *FollowService) GetRecommendations(ctx context.Context, userID uuid.UUID, limit int) ([]uuid.UUID, error) {
    return s.graphService.GetRecommendations(ctx, userID, limit)
}
```

### Junior → FAANG: Graph Database versus Relational Database for Social Graphs

The decision to use Neo4j for the social graph (with PostgreSQL as backup for simple queries) is a concrete example of the "right tool for the right job" principle. "Find mutual followers of user A and user B" in PostgreSQL requires a JOIN on the followers table, which is O(n) in the size of both users' follower lists. In Neo4j, this is a two-hop graph traversal that the graph engine executes natively using adjacency pointers.

For FAANG interviews, the social graph is a frequent system design topic. Know the two main representations: adjacency list (each user stores a list of followers and following) and adjacency matrix (a 2D matrix where cell (i, j)=1 means i follows j). Adjacency lists are the right representation for sparse graphs (which social networks are: users follow hundreds of people out of billions). Know why.

The Redis cache for adjacency sets (storing each user's following list in Redis as a Set) is the practical optimization: for news feed generation, you need the full following list for every user whose feed is being generated. Fetching this from Neo4j on every feed request would be too slow. Redis caches the adjacency set with a TTL and is used as the primary source for feed generation.

### Senior @ FAANG: Social Graph at FAANG Scale

At senior level, Neo4j has known scalability limits for social graphs at FAANG scale. LinkedIn has over 900M users with complex graph topologies. Neo4j's cluster (Community Edition: single node, Enterprise: cluster) cannot handle this volume with acceptable query latency. LinkedIn uses custom storage (built on top of RocksDB) with graph-specific partitioning and traversal algorithms.

The dual-write pattern (write to both PostgreSQL and Neo4j) in this implementation introduces consistency complexity: a partial failure (PostgreSQL write succeeds, Neo4j write fails) leaves the two stores inconsistent. The reconciliation mechanism (background job comparing PostgreSQL and Neo4j, correcting discrepancies) must be designed before the system goes to production.

Graph traversal performance depends critically on query patterns. "One-hop" queries (direct followers, direct following) are fast in any implementation. "Two-hop" queries (friends of friends) are fast in graph databases but require careful pagination in relational databases. "Three-hop and beyond" queries (social distance computation, shortest path) are expensive in all implementations and should be computed offline and cached rather than served on the hot path. The ADR for query pattern support must document which hops are supported online versus offline.

---
