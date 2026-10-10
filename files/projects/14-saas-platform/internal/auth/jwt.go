// internal/auth/jwt.go
package auth

import (
    "fmt"
    "net/http"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
    "github.com/google/uuid"
    "github.com/example/saas-platform/internal/isolation"
    "github.com/example/saas-platform/pkg/logger"
)

type TokenType string

const (
    TokenTypeAccess  TokenType = "access"
    TokenTypeRefresh TokenType = "refresh"
)

// Claims represents JWT claims
type Claims struct {
    UserID      string   `json:"user_id"`
    TenantID    string   `json:"tenant_id"`
    Email       string   `json:"email"`
    Role        string   `json:"role"`
    Permissions []string `json:"permissions"`
    TokenType   string   `json:"token_type"`
    jwt.RegisteredClaims
}

// JWTService handles JWT token operations
type JWTService struct {
    accessSecret  []byte
    refreshSecret []byte
    accessExpiry  time.Duration
    refreshExpiry time.Duration
}

func NewJWTService(accessSecret, refreshSecret string, accessExpiry, refreshExpiry time.Duration) *JWTService {
    return &JWTService{
        accessSecret:  []byte(accessSecret),
        refreshSecret: []byte(refreshSecret),
        accessExpiry:  accessExpiry,
        refreshExpiry: refreshExpiry,
    }
}

// GenerateTokenPair generates access and refresh tokens
func (s *JWTService) GenerateTokenPair(user *User) (accessToken, refreshToken string, err error) {
    // Generate access token
    accessToken, err = s.GenerateAccessToken(user)
    if err != nil {
        return "", "", err
    }

    // Generate refresh token
    refreshToken, err = s.GenerateRefreshToken(user)
    if err != nil {
        return "", "", err
    }

    return accessToken, refreshToken, nil
}

// GenerateAccessToken generates an access token
func (s *JWTService) GenerateAccessToken(user *User) (string, error) {
    now := time.Now()

    claims := Claims{
        UserID:      user.ID.String(),
        TenantID:    user.TenantID.String(),
        Email:       user.Email,
        Role:        string(user.Role),
        Permissions: user.Permissions,
        TokenType:   string(TokenTypeAccess),
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(now.Add(s.accessExpiry)),
            IssuedAt:  jwt.NewNumericDate(now),
            NotBefore: jwt.NewNumericDate(now),
            Issuer:    "tenantflow-auth",
            Subject:   user.ID.String(),
        },
    }

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return token.SignedString(s.accessSecret)
}

// GenerateRefreshToken generates a refresh token
func (s *JWTService) GenerateRefreshToken(user *User) (string, error) {
    now := time.Now()

    claims := Claims{
        UserID:    user.ID.String(),
        TenantID:  user.TenantID.String(),
        TokenType: string(TokenTypeRefresh),
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(now.Add(s.refreshExpiry)),
            IssuedAt:  jwt.NewNumericDate(now),
            NotBefore: jwt.NewNumericDate(now),
            Issuer:    "tenantflow-auth",
            Subject:   user.ID.String(),
        },
    }

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return token.SignedString(s.refreshSecret)
}

// ValidateAccessToken validates and parses an access token
func (s *JWTService) ValidateAccessToken(tokenString string) (*Claims, error) {
    return s.validateToken(tokenString, s.accessSecret, TokenTypeAccess)
}

// ValidateRefreshToken validates and parses a refresh token
func (s *JWTService) ValidateRefreshToken(tokenString string) (*Claims, error) {
    return s.validateToken(tokenString, s.refreshSecret, TokenTypeRefresh)
}

func (s *JWTService) validateToken(tokenString string, secret []byte, expectedType TokenType) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (any, error) {
        // Verify signing method
        if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return secret, nil
    })

    if err != nil {
        return nil, fmt.Errorf("failed to parse token: %w", err)
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, fmt.Errorf("invalid token")
    }

    // Verify token type
    if claims.TokenType != string(expectedType) {
        return nil, fmt.Errorf("invalid token type: expected %s, got %s", expectedType, claims.TokenType)
    }

    return claims, nil
}

// AuthMiddleware validates JWT and adds user/tenant context
type AuthMiddleware struct {
    jwtService    *JWTService
    userRepo      UserRepository
    sessionRepo   SessionRepository
    logger        logger.Logger
}

func NewAuthMiddleware(jwtService *JWTService, userRepo UserRepository, sessionRepo SessionRepository, logger logger.Logger) *AuthMiddleware {
    return &AuthMiddleware{
        jwtService:  jwtService,
        userRepo:    userRepo,
        sessionRepo: sessionRepo,
        logger:      logger,
    }
}

func (m *AuthMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract token from Authorization header
        authHeader := r.Header.Get("Authorization")
        if authHeader == "" {
            http.Error(w, "Missing authorization header", http.StatusUnauthorized)
            return
        }

        // Remove "Bearer " prefix
        tokenString := strings.TrimPrefix(authHeader, "Bearer ")
        if tokenString == authHeader {
            http.Error(w, "Invalid authorization header format", http.StatusUnauthorized)
            return
        }

        // Validate token
        claims, err := m.jwtService.ValidateAccessToken(tokenString)
        if err != nil {
            m.logger.Debug("invalid token", "error", err)
            http.Error(w, "Invalid token", http.StatusUnauthorized)
            return
        }

        // Parse IDs
        userID, err := uuid.Parse(claims.UserID)
        if err != nil {
            http.Error(w, "Invalid user ID in token", http.StatusUnauthorized)
            return
        }

        tenantID, err := uuid.Parse(claims.TenantID)
        if err != nil {
            http.Error(w, "Invalid tenant ID in token", http.StatusUnauthorized)
            return
        }

        // Verify user still exists and is active
        user, err := m.userRepo.GetByID(r.Context(), userID)
        if err != nil {
            m.logger.Error("failed to get user", "error", err, "user_id", userID)
            http.Error(w, "User not found", http.StatusUnauthorized)
            return
        }

        if user.Status != UserStatusActive {
            http.Error(w, "User account is not active", http.StatusForbidden)
            return
        }

        // Add user context
        userCtx := &isolation.UserContext{
            UserID:      userID,
            TenantID:    tenantID,
            Email:       claims.Email,
            Role:        claims.Role,
            Permissions: claims.Permissions,
        }

        ctx := isolation.WithUser(r.Context(), userCtx)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// OptionalAuthMiddleware adds auth context if token present, but doesn't require it
type OptionalAuthMiddleware struct {
    authMiddleware *AuthMiddleware
}

func (m *OptionalAuthMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        authHeader := r.Header.Get("Authorization")
        if authHeader == "" {
            // No auth provided, continue without user context
            next.ServeHTTP(w, r)
            return
        }

        // Auth provided, validate it
        m.authMiddleware.Handler(next).ServeHTTP(w, r)
    })
}
