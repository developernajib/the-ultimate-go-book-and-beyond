package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type JWTService struct {
	secret     []byte
	expiration time.Duration
}

type Claims struct {
	UserID   uuid.UUID `json:"user_id"`
	Username string    `json:"username"`
	jwt.RegisteredClaims
}

func NewJWTService(secret string, expiration time.Duration) *JWTService {
	return &JWTService{
		secret:     []byte(secret),
		expiration: expiration,
	}
}

func (s *JWTService) GenerateToken(userID uuid.UUID, username string) (string, error) {
	claims := &Claims{
		UserID:   userID,
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(s.expiration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

func (s *JWTService) ValidateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.secret, nil
	})

	if err != nil {
		return nil, fmt.Errorf("parse token: %w", err)
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}

func (s *JWTService) RefreshToken(tokenString string) (string, error) {
	claims, err := s.ValidateToken(tokenString)
	if err != nil {
		return "", err
	}

	// Generate new token with same claims
	return s.GenerateToken(claims.UserID, claims.Username)
}
