// internal/domain/user.go
package domain

import (
    "time"
    "github.com/google/uuid"
)

type User struct {
    ID            uuid.UUID  `json:"id" db:"id"`
    Username      string     `json:"username" db:"username"`
    Email         string     `json:"email" db:"email"`
    PasswordHash  string     `json:"-" db:"password_hash"`
    DisplayName   string     `json:"display_name" db:"display_name"`
    Bio           *string    `json:"bio" db:"bio"`
    AvatarURL     *string    `json:"avatar_url" db:"avatar_url"`
    CoverURL      *string    `json:"cover_url" db:"cover_url"`
    Location      *string    `json:"location" db:"location"`
    Website       *string    `json:"website" db:"website"`
    BirthDate     *time.Time `json:"birth_date" db:"birth_date"`
    IsVerified    bool       `json:"is_verified" db:"is_verified"`
    IsPrivate     bool       `json:"is_private" db:"is_private"`
    FollowerCount int        `json:"follower_count" db:"follower_count"`
    FollowingCount int       `json:"following_count" db:"following_count"`
    PostCount     int        `json:"post_count" db:"post_count"`
    CreatedAt     time.Time  `json:"created_at" db:"created_at"`
    UpdatedAt     time.Time  `json:"updated_at" db:"updated_at"`
    LastSeenAt    *time.Time `json:"last_seen_at" db:"last_seen_at"`
    DeletedAt     *time.Time `json:"deleted_at" db:"deleted_at"`
}

// Public returns a public-safe user representation
func (u *User) Public() *PublicUser {
    return &PublicUser{
        ID:             u.ID,
        Username:       u.Username,
        DisplayName:    u.DisplayName,
        Bio:            u.Bio,
        AvatarURL:      u.AvatarURL,
        CoverURL:       u.CoverURL,
        Location:       u.Location,
        Website:        u.Website,
        IsVerified:     u.IsVerified,
        IsPrivate:      u.IsPrivate,
        FollowerCount:  u.FollowerCount,
        FollowingCount: u.FollowingCount,
        PostCount:      u.PostCount,
        CreatedAt:      u.CreatedAt,
    }
}

type PublicUser struct {
    ID             uuid.UUID  `json:"id"`
    Username       string     `json:"username"`
    DisplayName    string     `json:"display_name"`
    Bio            *string    `json:"bio"`
    AvatarURL      *string    `json:"avatar_url"`
    CoverURL       *string    `json:"cover_url"`
    Location       *string    `json:"location"`
    Website        *string    `json:"website"`
    IsVerified     bool       `json:"is_verified"`
    IsPrivate      bool       `json:"is_private"`
    FollowerCount  int        `json:"follower_count"`
    FollowingCount int        `json:"following_count"`
    PostCount      int        `json:"post_count"`
    CreatedAt      time.Time  `json:"created_at"`
}

type UserSettings struct {
    UserID              uuid.UUID `json:"user_id" db:"user_id"`
    PrivacyLevel        string    `json:"privacy_level" db:"privacy_level"`
    AllowMentions       bool      `json:"allow_mentions" db:"allow_mentions"`
    AllowDMs            bool      `json:"allow_dms" db:"allow_dms"`
    ShowActivity        bool      `json:"show_activity" db:"show_activity"`
    EmailNotifications  bool      `json:"email_notifications" db:"email_notifications"`
    PushNotifications   bool      `json:"push_notifications" db:"push_notifications"`
    Language            string    `json:"language" db:"language"`
    Timezone            string    `json:"timezone" db:"timezone"`
    Theme               string    `json:"theme" db:"theme"`
    CreatedAt           time.Time `json:"created_at" db:"created_at"`
    UpdatedAt           time.Time `json:"updated_at" db:"updated_at"`
}

type CreateUserRequest struct {
    Username    string    `json:"username" validate:"required,min=3,max=30,alphanum"`
    Email       string    `json:"email" validate:"required,email"`
    Password    string    `json:"password" validate:"required,min=8"`
    DisplayName string    `json:"display_name" validate:"required,min=1,max=100"`
    BirthDate   time.Time `json:"birth_date" validate:"required"`
}

type UpdateUserRequest struct {
    DisplayName *string `json:"display_name" validate:"omitempty,min=1,max=100"`
    Bio         *string `json:"bio" validate:"omitempty,max=500"`
    Location    *string `json:"location" validate:"omitempty,max=100"`
    Website     *string `json:"website" validate:"omitempty,url"`
}

type LoginRequest struct {
    Email    string `json:"email" validate:"required,email"`
    Password string `json:"password" validate:"required"`
}

type LoginResponse struct {
    User  *PublicUser `json:"user"`
    Token string      `json:"token"`
}
