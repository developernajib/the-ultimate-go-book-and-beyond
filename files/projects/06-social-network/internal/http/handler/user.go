// internal/http/handler/user.go
package handler

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/jwtauth/v5"
    "github.com/go-playground/validator/v10"
    "github.com/google/uuid"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/service"
    "go.uber.org/zap"
)

type UserHandler struct {
    userService *service.UserService
    validator   *validator.Validate
    tokenAuth   *jwtauth.JWTAuth
    logger      *zap.Logger
}

func NewUserHandler(
    userService *service.UserService,
    validator *validator.Validate,
    tokenAuth *jwtauth.JWTAuth,
    logger *zap.Logger,
) *UserHandler {
    return &UserHandler{
        userService: userService,
        validator:   validator,
        tokenAuth:   tokenAuth,
        logger:      logger,
    }
}

func (h *UserHandler) Register(w http.ResponseWriter, r *http.Request) {
    var req domain.CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    if err := h.validator.Struct(req); err != nil {
        respondError(w, http.StatusBadRequest, err.Error())
        return
    }

    user, err := h.userService.CreateUser(r.Context(), &req)
    if err != nil {
        switch err {
        case service.ErrUsernameExists:
            respondError(w, http.StatusConflict, "username already exists")
        case service.ErrEmailExists:
            respondError(w, http.StatusConflict, "email already exists")
        default:
            h.logger.Error("failed to create user", zap.Error(err))
            respondError(w, http.StatusInternalServerError, "internal server error")
        }
        return
    }

    // Generate JWT token
    token, err := h.generateToken(user)
    if err != nil {
        h.logger.Error("failed to generate token", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusCreated, domain.LoginResponse{
        User:  user.Public(),
        Token: token,
    })
}

func (h *UserHandler) Login(w http.ResponseWriter, r *http.Request) {
    var req domain.LoginRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    if err := h.validator.Struct(req); err != nil {
        respondError(w, http.StatusBadRequest, err.Error())
        return
    }

    user, err := h.userService.Login(r.Context(), &req)
    if err != nil {
        if err == service.ErrInvalidCredentials {
            respondError(w, http.StatusUnauthorized, "invalid credentials")
            return
        }
        h.logger.Error("failed to login", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    // Generate JWT token
    token, err := h.generateToken(user)
    if err != nil {
        h.logger.Error("failed to generate token", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusOK, domain.LoginResponse{
        User:  user.Public(),
        Token: token,
    })
}

func (h *UserHandler) GetCurrentUser(w http.ResponseWriter, r *http.Request) {
    userID := getUserIDFromContext(r.Context())

    user, err := h.userService.GetUser(r.Context(), userID)
    if err != nil {
        if err == domain.ErrUserNotFound {
            respondError(w, http.StatusNotFound, "user not found")
            return
        }
        h.logger.Error("failed to get user", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusOK, user.Public())
}

func (h *UserHandler) GetUserByUsername(w http.ResponseWriter, r *http.Request) {
    username := chi.URLParam(r, "username")

    user, err := h.userService.GetUserByUsername(r.Context(), username)
    if err != nil {
        if err == domain.ErrUserNotFound {
            respondError(w, http.StatusNotFound, "user not found")
            return
        }
        h.logger.Error("failed to get user", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusOK, user.Public())
}

func (h *UserHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
    userID := getUserIDFromContext(r.Context())

    var req domain.UpdateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    if err := h.validator.Struct(req); err != nil {
        respondError(w, http.StatusBadRequest, err.Error())
        return
    }

    user, err := h.userService.UpdateUser(r.Context(), userID, &req)
    if err != nil {
        h.logger.Error("failed to update user", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    respondJSON(w, http.StatusOK, user.Public())
}

func (h *UserHandler) SearchUsers(w http.ResponseWriter, r *http.Request) {
    query := r.URL.Query().Get("q")
    if query == "" {
        respondError(w, http.StatusBadRequest, "query parameter 'q' is required")
        return
    }

    limit := parseIntQuery(r, "limit", 20)
    offset := parseIntQuery(r, "offset", 0)

    users, err := h.userService.SearchUsers(r.Context(), query, limit, offset)
    if err != nil {
        h.logger.Error("failed to search users", zap.Error(err))
        respondError(w, http.StatusInternalServerError, "internal server error")
        return
    }

    // Convert to public users
    publicUsers := make([]*domain.PublicUser, len(users))
    for i, user := range users {
        publicUsers[i] = user.Public()
    }

    respondJSON(w, http.StatusOK, map[string]any{
        "users":  publicUsers,
        "limit":  limit,
        "offset": offset,
    })
}

func (h *UserHandler) generateToken(user *domain.User) (string, error) {
    claims := map[string]any{
        "user_id":  user.ID.String(),
        "username": user.Username,
        "exp":      time.Now().Add(24 * time.Hour).Unix(),
    }

    _, tokenString, err := h.tokenAuth.Encode(claims)
    return tokenString, err
}

// Helper functions
func respondJSON(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
    respondJSON(w, status, map[string]string{"error": message})
}

func getUserIDFromContext(ctx context.Context) uuid.UUID {
    _, claims, _ := jwtauth.FromContext(ctx)
    userIDStr := claims["user_id"].(string)
    userID, _ := uuid.Parse(userIDStr)
    return userID
}

func parseIntQuery(r *http.Request, key string, defaultValue int) int {
    value := r.URL.Query().Get(key)
    if value == "" {
        return defaultValue
    }

    var result int
    if _, err := fmt.Sscanf(value, "%d", &result); err != nil {
        return defaultValue
    }

    return result
}
