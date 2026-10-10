// pkg/types/errors.go
package types

import "errors"

var (
	// Order errors
	ErrInvalidOrder        = errors.New("invalid order")
	ErrInvalidPrice        = errors.New("invalid price")
	ErrInvalidQuantity     = errors.New("invalid quantity")
	ErrOrderNotFound       = errors.New("order not found")
	ErrDuplicateOrder      = errors.New("duplicate order")

	// Risk errors
	ErrInsufficientBalance = errors.New("insufficient balance")
	ErrPositionLimitExceeded = errors.New("position limit exceeded")
	ErrRiskLimitExceeded   = errors.New("risk limit exceeded")
	ErrMaxOrderSizeExceeded = errors.New("max order size exceeded")

	// Market data errors
	ErrInvalidMarketData   = errors.New("invalid market data")
	ErrStaleData           = errors.New("stale market data")
	ErrNoLiquidity         = errors.New("no liquidity")

	// Exchange errors
	ErrExchangeConnection  = errors.New("exchange connection error")
	ErrExchangeRateLimit   = errors.New("exchange rate limit exceeded")
	ErrExchangeRejection   = errors.New("exchange rejected order")

	// System errors
	ErrSystemOverload      = errors.New("system overload")
	ErrTimeout             = errors.New("operation timeout")
	ErrShutdown            = errors.New("system shutting down")
)

// OrderError wraps order-specific errors with context
type OrderError struct {
	Order *Order
	Err   error
}

func (e *OrderError) Error() string {
	return e.Err.Error()
}

func (e *OrderError) Unwrap() error {
	return e.Err
}
