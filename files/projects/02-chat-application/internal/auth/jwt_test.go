package auth

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestJWTService_GenerateAndValidate(t *testing.T) {
	svc := NewJWTService("test-secret-key-1234567890123456", time.Hour)
	userID := uuid.New()
	username := "alice"

	token, err := svc.GenerateToken(userID, username)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}

	claims, err := svc.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken failed: %v", err)
	}

	if claims.UserID != userID || claims.Username != username {
		t.Errorf("claims mismatch: got user %v (%s), want %v (%s)", claims.UserID, claims.Username, userID, username)
	}
}

func TestJWTService_ExpiredToken(t *testing.T) {
	svc := NewJWTService("test-secret-key-1234567890123456", -time.Minute)
	userID := uuid.New()
	username := "bob"

	token, err := svc.GenerateToken(userID, username)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}

	_, err = svc.ValidateToken(token)
	if err == nil {
		t.Fatalf("expected error for expired token, got nil")
	}
}

func TestJWTService_RefreshToken(t *testing.T) {
	svc := NewJWTService("test-secret-key-1234567890123456", time.Hour)
	userID := uuid.New()
	username := "charlie"

	token, err := svc.GenerateToken(userID, username)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}

	newToken, err := svc.RefreshToken(token)
	if err != nil {
		t.Fatalf("RefreshToken failed: %v", err)
	}

	claims, err := svc.ValidateToken(newToken)
	if err != nil {
		t.Fatalf("ValidateToken on refreshed token failed: %v", err)
	}

	if claims.Username != username {
		t.Errorf("expected username %s, got %s", username, claims.Username)
	}
}
