package domain

import "errors"

var (
	ErrProductNotFound        = errors.New("product not found")
	ErrCategoryNotFound       = errors.New("category not found")
	ErrInvalidProductName     = errors.New("invalid product name")
	ErrInvalidSKU             = errors.New("invalid SKU")
	ErrInvalidPrice           = errors.New("invalid price")
	ErrInvalidInventory       = errors.New("invalid inventory")
	ErrInsufficientInventory  = errors.New("insufficient inventory")
	ErrReservationNotFound    = errors.New("reservation not found")
	ErrReservationExpired     = errors.New("reservation expired")
	ErrReservationAlreadyUsed = errors.New("reservation already used")
	ErrDuplicateSKU           = errors.New("duplicate SKU")
)
