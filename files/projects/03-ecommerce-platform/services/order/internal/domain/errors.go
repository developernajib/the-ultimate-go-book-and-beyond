package domain

import "errors"

var (
	ErrOrderNotFound    = errors.New("order not found")
	ErrInvalidUserID    = errors.New("invalid user ID")
	ErrInvalidProductID = errors.New("invalid product ID")
	ErrInvalidQuantity  = errors.New("invalid quantity")
	ErrInvalidPrice     = errors.New("invalid price")
	ErrNoItems          = errors.New("order must have at least one item")
	ErrCannotCancel     = errors.New("order cannot be cancelled")
	ErrCannotRefund     = errors.New("order cannot be refunded")
	ErrInvalidStatus    = errors.New("invalid order status")
)
