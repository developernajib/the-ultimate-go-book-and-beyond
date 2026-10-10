// internal/domain/errors.go
package domain

import "errors"

var (
	ErrUserNotFound     = errors.New("user not found")
	ErrPostNotFound     = errors.New("post not found")
	ErrSettingsNotFound = errors.New("settings not found")
)
