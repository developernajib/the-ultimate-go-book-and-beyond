package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/example/chat-application/internal/auth"
	"github.com/example/chat-application/internal/models"
	"github.com/example/chat-application/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type Handlers struct {
	pgStore    *storage.PostgresStore
	redisStore *storage.RedisStore
	jwtService *auth.JWTService
}

func NewHandlers(pgStore *storage.PostgresStore, redisStore *storage.RedisStore, jwtService *auth.JWTService) *Handlers {
	return &Handlers{
		pgStore:    pgStore,
		redisStore: redisStore,
		jwtService: jwtService,
	}
}

// Authentication handlers

func (h *Handlers) Register(w http.ResponseWriter, r *http.Request) {
	var req models.CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate request
	if req.Username == "" || req.Email == "" || req.Password == "" {
		respondError(w, http.StatusBadRequest, "Missing required fields")
		return
	}

	if len(req.Password) < 8 {
		respondError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}

	// Hash password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Error creating user")
		return
	}

	// Create user
	user, err := h.pgStore.CreateUser(r.Context(), &req, string(hashedPassword))
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Generate JWT
	token, err := h.jwtService.GenerateToken(user.ID, user.Username)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Error generating token")
		return
	}

	respondJSON(w, http.StatusCreated, &models.LoginResponse{
		Token: token,
		User:  user.ToPublic(),
	})
}

func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	var req models.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Get user by username
	user, err := h.pgStore.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	// Verify password
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		respondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	// Generate JWT
	token, err := h.jwtService.GenerateToken(user.ID, user.Username)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Error generating token")
		return
	}

	respondJSON(w, http.StatusOK, &models.LoginResponse{
		Token: token,
		User:  user.ToPublic(),
	})
}

// Channel handlers

func (h *Handlers) CreateChannel(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var req models.CreateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	channel, err := h.pgStore.CreateChannel(r.Context(), &req, userID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusCreated, channel)
}

func (h *Handlers) GetChannels(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	channels, err := h.pgStore.GetUserChannels(r.Context(), userID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, channels)
}

func (h *Handlers) GetChannel(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	channelID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid channel ID")
		return
	}

	// Check if user is member of channel
	isMember, err := h.pgStore.IsUserInChannel(r.Context(), userID, channelID)
	if err != nil || !isMember {
		respondError(w, http.StatusForbidden, "Access denied")
		return
	}

	channel, err := h.pgStore.GetChannelByID(r.Context(), channelID)
	if err != nil {
		respondError(w, http.StatusNotFound, "Channel not found")
		return
	}

	respondJSON(w, http.StatusOK, channel)
}

// Message handlers

func (h *Handlers) GetMessages(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	channelID, err := uuid.Parse(chi.URLParam(r, "channelId"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid channel ID")
		return
	}

	// Check if user is member of channel
	isMember, err := h.pgStore.IsUserInChannel(r.Context(), userID, channelID)
	if err != nil || !isMember {
		respondError(w, http.StatusForbidden, "Access denied")
		return
	}

	// Parse query parameters
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	var before *uuid.UUID
	beforeStr := r.URL.Query().Get("before")
	if beforeStr != "" {
		if b, err := uuid.Parse(beforeStr); err == nil {
			before = &b
		}
	}

	messages, err := h.pgStore.GetMessages(r.Context(), channelID, limit, before)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, messages)
}

func (h *Handlers) SearchMessages(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		respondError(w, http.StatusBadRequest, "Missing query parameter")
		return
	}

	var channelID *uuid.UUID
	channelIDStr := r.URL.Query().Get("channel_id")
	if channelIDStr != "" {
		cid, err := uuid.Parse(channelIDStr)
		if err == nil {
			// Verify user has access to channel
			isMember, err := h.pgStore.IsUserInChannel(r.Context(), userID, cid)
			if err == nil && isMember {
				channelID = &cid
			}
		}
	}

	limit := 20
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	offset := 0
	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		if o, err := strconv.Atoi(offsetStr); err == nil && o >= 0 {
			offset = o
		}
	}

	messages, err := h.pgStore.SearchMessages(r.Context(), query, channelID, limit, offset)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, messages)
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
