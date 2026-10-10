// internal/service/post.go
package service

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/domain/repository"
    "go.uber.org/zap"
)

type PostService struct {
    postRepo repository.PostRepository
    userRepo repository.UserRepository
    feedService *FeedService
    notifService *NotificationService
    logger   *zap.Logger
}

func NewPostService(
    postRepo repository.PostRepository,
    userRepo repository.UserRepository,
    feedService *FeedService,
    notifService *NotificationService,
    logger *zap.Logger,
) *PostService {
    return &PostService{
        postRepo: postRepo,
        userRepo: userRepo,
        feedService: feedService,
        notifService: notifService,
        logger:   logger,
    }
}

func (s *PostService) CreatePost(ctx context.Context, userID uuid.UUID, req *domain.CreatePostRequest) (*domain.Post, error) {
    // Validate that at least one field is provided
    if req.Content == "" && len(req.MediaURLs) == 0 && req.RepostOfID == nil {
        return nil, fmt.Errorf("post must have content, media, or be a repost")
    }

    // Create post
    post := &domain.Post{
        ID:         uuid.New(),
        UserID:     userID,
        Content:    req.Content,
        MediaURLs:  req.MediaURLs,
        ReplyToID:  req.ReplyToID,
        RepostOfID: req.RepostOfID,
        Visibility: req.Visibility,
    }

    if post.Visibility == "" {
        post.Visibility = "public"
    }

    if err := s.postRepo.Create(ctx, post); err != nil {
        return nil, fmt.Errorf("create post: %w", err)
    }

    // Increment user post count
    if err := s.userRepo.IncrementPostCount(ctx, userID, 1); err != nil {
        s.logger.Error("failed to increment post count", zap.Error(err))
    }

    // Fan-out to followers' feeds (async)
    go func() {
        ctx := context.Background()
        if err := s.feedService.FanOutPost(ctx, post); err != nil {
            s.logger.Error("failed to fan out post",
                zap.String("post_id", post.ID.String()),
                zap.Error(err),
            )
        }
    }()

    // Send notifications for mentions (async)
    if len(post.Mentions) > 0 {
        go func() {
            ctx := context.Background()
            for _, mentionedUserID := range post.Mentions {
                _ = s.notifService.CreateNotification(ctx, &domain.Notification{
                    UserID:     mentionedUserID,
                    ActorID:    &userID,
                    Type:       "mention",
                    EntityType: "post",
                    EntityID:   &post.ID,
                })
            }
        }()
    }

    // Handle reply notifications
    if post.ReplyToID != nil {
        go func() {
            ctx := context.Background()
            originalPost, err := s.postRepo.GetByID(ctx, *post.ReplyToID)
            if err == nil && originalPost.UserID != userID {
                _ = s.notifService.CreateNotification(ctx, &domain.Notification{
                    UserID:     originalPost.UserID,
                    ActorID:    &userID,
                    Type:       "reply",
                    EntityType: "post",
                    EntityID:   &post.ID,
                })
            }
        }()
    }

    s.logger.Info("post created",
        zap.String("post_id", post.ID.String()),
        zap.String("user_id", userID.String()),
    )

    return post, nil
}

func (s *PostService) GetPost(ctx context.Context, postID uuid.UUID, viewerID *uuid.UUID) (*domain.Post, error) {
    post, err := s.postRepo.GetByID(ctx, postID)
    if err != nil {
        return nil, err
    }

    // Get author information
    author, err := s.userRepo.GetByID(ctx, post.UserID)
    if err == nil {
        post.Author = author.Public()
    }

    // Check if viewer has liked the post
    if viewerID != nil {
        isLiked, err := s.postRepo.IsLiked(ctx, postID, *viewerID)
        if err == nil {
            post.IsLiked = isLiked
        }
    }

    return post, nil
}

func (s *PostService) GetUserPosts(ctx context.Context, userID uuid.UUID, limit, offset int) ([]*domain.Post, error) {
    if limit <= 0 || limit > 50 {
        limit = 20
    }

    posts, err := s.postRepo.GetByUserID(ctx, userID, limit, offset)
    if err != nil {
        return nil, err
    }

    // Hydrate with author info
    if len(posts) > 0 {
        author, err := s.userRepo.GetByID(ctx, userID)
        if err == nil {
            publicAuthor := author.Public()
            for _, post := range posts {
                post.Author = publicAuthor
            }
        }
    }

    return posts, nil
}

func (s *PostService) UpdatePost(ctx context.Context, postID, userID uuid.UUID, req *domain.UpdatePostRequest) (*domain.Post, error) {
    post, err := s.postRepo.GetByID(ctx, postID)
    if err != nil {
        return nil, err
    }

    // Check ownership
    if post.UserID != userID {
        return nil, fmt.Errorf("unauthorized: not post owner")
    }

    post.Content = req.Content

    if err := s.postRepo.Update(ctx, post); err != nil {
        return nil, fmt.Errorf("update post: %w", err)
    }

    s.logger.Info("post updated",
        zap.String("post_id", postID.String()),
    )

    return post, nil
}

func (s *PostService) DeletePost(ctx context.Context, postID, userID uuid.UUID) error {
    post, err := s.postRepo.GetByID(ctx, postID)
    if err != nil {
        return err
    }

    // Check ownership
    if post.UserID != userID {
        return fmt.Errorf("unauthorized: not post owner")
    }

    if err := s.postRepo.Delete(ctx, postID); err != nil {
        return fmt.Errorf("delete post: %w", err)
    }

    // Decrement user post count
    if err := s.userRepo.IncrementPostCount(ctx, userID, -1); err != nil {
        s.logger.Error("failed to decrement post count", zap.Error(err))
    }

    s.logger.Info("post deleted",
        zap.String("post_id", postID.String()),
    )

    return nil
}

func (s *PostService) LikePost(ctx context.Context, postID, userID uuid.UUID) error {
    // Get post to find author
    post, err := s.postRepo.GetByID(ctx, postID)
    if err != nil {
        return err
    }

    if err := s.postRepo.LikePost(ctx, postID, userID); err != nil {
        return fmt.Errorf("like post: %w", err)
    }

    // Send notification to post author (if not self-like)
    if post.UserID != userID {
        go func() {
            ctx := context.Background()
            _ = s.notifService.CreateNotification(ctx, &domain.Notification{
                UserID:     post.UserID,
                ActorID:    &userID,
                Type:       "like",
                EntityType: "post",
                EntityID:   &postID,
            })
        }()
    }

    s.logger.Info("post liked",
        zap.String("post_id", postID.String()),
        zap.String("user_id", userID.String()),
    )

    return nil
}

func (s *PostService) UnlikePost(ctx context.Context, postID, userID uuid.UUID) error {
    if err := s.postRepo.UnlikePost(ctx, postID, userID); err != nil {
        return fmt.Errorf("unlike post: %w", err)
    }

    s.logger.Info("post unliked",
        zap.String("post_id", postID.String()),
        zap.String("user_id", userID.String()),
    )

    return nil
}

func (s *PostService) GetPostLikes(ctx context.Context, postID uuid.UUID, limit, offset int) ([]*domain.PublicUser, error) {
    userIDs, err := s.postRepo.GetLikes(ctx, postID, limit, offset)
    if err != nil {
        return nil, err
    }

    if len(userIDs) == 0 {
        return []*domain.PublicUser{}, nil
    }

    users, err := s.userRepo.GetByIDs(ctx, userIDs)
    if err != nil {
        return nil, err
    }

    publicUsers := make([]*domain.PublicUser, len(users))
    for i, user := range users {
        publicUsers[i] = user.Public()
    }

    return publicUsers, nil
}
