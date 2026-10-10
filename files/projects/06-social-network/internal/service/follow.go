// internal/service/follow.go
package service

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/example/social-network/internal/domain/repository"
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
