// internal/models/url.go
package models

import (
	"time"
)

// URL represents a shortened URL
type URL struct {
	ID             int64      `db:"id"`
	ShortCode      string     `db:"short_code"`
	LongURL        string     `db:"long_url"`
	UserID         *int64     `db:"user_id"`
	CreatedAt      time.Time  `db:"created_at"`
	ExpiresAt      *time.Time `db:"expires_at"`
	Active         bool       `db:"active"`
	Clicks         int64      `db:"clicks"`
	LastAccessedAt *time.Time `db:"last_accessed_at"`
}

// User represents a registered user
type User struct {
	ID               int64      `db:"id"`
	Email            string     `db:"email"`
	PasswordHash     string     `db:"password_hash"`
	APIKey           string     `db:"api_key"`
	Tier             string     `db:"tier"`
	RateLimitPerHour int        `db:"rate_limit_per_hour"`
	RateLimitPerDay  int        `db:"rate_limit_per_day"`
	CreatedAt        time.Time  `db:"created_at"`
	LastLoginAt      *time.Time `db:"last_login_at"`
	Active           bool       `db:"active"`
}

// ClickEvent represents a single click/redirect event
type ClickEvent struct {
	ID          int64     `db:"id"`
	ShortCode   string    `db:"short_code"`
	IPAddress   string    `db:"ip_address"`
	UserAgent   string    `db:"user_agent"`
	Referer     string    `db:"referer"`
	CountryCode string    `db:"country_code"`
	City        string    `db:"city"`
	DeviceType  string    `db:"device_type"`
	OS          string    `db:"os"`
	Browser     string    `db:"browser"`
	Timestamp   time.Time `db:"timestamp"`
}

// CustomDomain represents a custom domain for enterprise users
type CustomDomain struct {
	ID                int64     `db:"id"`
	UserID            int64     `db:"user_id"`
	Domain            string    `db:"domain"`
	Verified          bool      `db:"verified"`
	VerificationToken string    `db:"verification_token"`
	CreatedAt         time.Time `db:"created_at"`
}
