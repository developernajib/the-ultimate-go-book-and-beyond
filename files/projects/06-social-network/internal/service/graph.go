// internal/service/graph.go
package service

import (
    "context"
    "fmt"

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
