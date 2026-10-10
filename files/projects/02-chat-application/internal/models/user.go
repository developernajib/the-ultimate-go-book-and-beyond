package models

import (
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID           uuid.UUID  `json:"id" db:"id"`
	Username     string     `json:"username" db:"username"`
	Email        string     `json:"email" db:"email"`
	PasswordHash string     `json:"-" db:"password_hash"`
	DisplayName  string     `json:"display_name" db:"display_name"`
	AvatarURL    string     `json:"avatar_url" db:"avatar_url"`
	Status       UserStatus `json:"status" db:"status"`
	CustomStatus string     `json:"custom_status" db:"custom_status"`
	CreatedAt    time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at" db:"updated_at"`
	LastSeenAt   *time.Time `json:"last_seen_at" db:"last_seen_at"`
	DeletedAt    *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}

type UserStatus string

const (
	UserStatusOnline  UserStatus = "online"
	UserStatusOffline UserStatus = "offline"
	UserStatusAway    UserStatus = "away"
	UserStatusBusy    UserStatus = "busy"
)

// PublicUser returns user data safe for public consumption
type PublicUser struct {
	ID           uuid.UUID  `json:"id"`
	Username     string     `json:"username"`
	DisplayName  string     `json:"display_name"`
	AvatarURL    string     `json:"avatar_url"`
	Status       UserStatus `json:"status"`
	CustomStatus string     `json:"custom_status"`
	LastSeenAt   *time.Time `json:"last_seen_at,omitempty"`
}

func (u *User) ToPublic() *PublicUser {
	return &PublicUser{
		ID:           u.ID,
		Username:     u.Username,
		DisplayName:  u.DisplayName,
		AvatarURL:    u.AvatarURL,
		Status:       u.Status,
		CustomStatus: u.CustomStatus,
		LastSeenAt:   u.LastSeenAt,
	}
}

type CreateUserRequest struct {
	Username    string `json:"username" validate:"required,min=3,max=50"`
	Email       string `json:"email" validate:"required,email"`
	Password    string `json:"password" validate:"required,min=8"`
	DisplayName string `json:"display_name" validate:"max=100"`
}

type LoginRequest struct {
	Username string `json:"username" validate:"required"`
	Password string `json:"password" validate:"required"`
}

type LoginResponse struct {
	Token string      `json:"token"`
	User  *PublicUser `json:"user"`
}
