package handlers

import (
	"net/http"

	"go.uber.org/zap"
)

// PaymentHandler handles payment-related requests
type PaymentHandler struct {
	logger *zap.Logger
}

// NewPaymentHandler creates a new PaymentHandler
func NewPaymentHandler(logger *zap.Logger) *PaymentHandler {
	return &PaymentHandler{logger: logger}
}

// HandleWebhook handles Stripe webhook events
func (h *PaymentHandler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ensure zap is used
var _ = zap.String
