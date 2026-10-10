package api

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/example/chat-application/internal/auth"
	"github.com/example/chat-application/internal/storage"
	"github.com/google/uuid"
)

const (
	maxUploadSize = 10 << 20 // 10 MB
	maxImageSize  = 5 << 20  // 5 MB
)

type UploadHandler struct {
	s3Store *storage.S3Store
	pgStore *storage.PostgresStore
}

func NewUploadHandler(s3Store *storage.S3Store, pgStore *storage.PostgresStore) *UploadHandler {
	return &UploadHandler{
		s3Store: s3Store,
		pgStore: pgStore,
	}
}

func (h *UploadHandler) UploadFile(w http.ResponseWriter, r *http.Request) {
	userID, err := auth.GetUserID(r.Context())
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	// Parse multipart form
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		respondError(w, http.StatusBadRequest, "File too large")
		return
	}

	// Get file from form
	file, header, err := r.FormFile("file")
	if err != nil {
		respondError(w, http.StatusBadRequest, "No file uploaded")
		return
	}
	defer file.Close()

	// Get channel ID
	channelIDStr := r.FormValue("channel_id")
	channelID, err := uuid.Parse(channelIDStr)
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

	// Validate file type
	contentType := header.Header.Get("Content-Type")
	ext := filepath.Ext(header.Filename)

	// Upload based on type
	var storageKey, thumbnailKey string
	var imgWidth, imgHeight int

	if isImage(contentType) {
		// Upload image with thumbnail
		if header.Size > maxImageSize {
			respondError(w, http.StatusBadRequest, "Image too large")
			return
		}

		url, thumbURL, imgW, imgH, err := h.s3Store.UploadImage(r.Context(), file, header.Filename)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Error uploading image")
			return
		}

		storageKey = url
		thumbnailKey = thumbURL
		imgWidth = imgW
		imgHeight = imgH
	} else {
		// Upload regular file
		key := fmt.Sprintf("files/%s%s", uuid.New().String(), ext)
		url, err := h.s3Store.UploadFile(r.Context(), key, file, contentType)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Error uploading file")
			return
		}
		storageKey = url
	}

	// Save attachment record (would be linked to a message)
	attachment := map[string]any{
		"filename":      header.Filename,
		"file_size":     header.Size,
		"mime_type":     contentType,
		"storage_key":   storageKey,
		"thumbnail_key": thumbnailKey,
		"width":         imgWidth,
		"height":        imgHeight,
	}

	respondJSON(w, http.StatusOK, attachment)
}

func isImage(contentType string) bool {
	return strings.HasPrefix(contentType, "image/")
}
