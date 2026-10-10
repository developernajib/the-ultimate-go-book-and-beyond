package logging

import (
	"context"
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

type contextKey string

const (
	loggerKey        contextKey = "logger"
	requestIDKey     contextKey = "request_id"
	correlationIDKey contextKey = "correlation_id"
)

var defaultLogger *zap.Logger

func init() {
	config := zap.NewProductionConfig()
	config.EncoderConfig.TimeKey = "timestamp"
	config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	var err error
	defaultLogger, err = config.Build()
	if err != nil {
		panic(err)
	}
}

// Logger returns a logger with context fields
func Logger(ctx context.Context) *zap.Logger {
	if logger, ok := ctx.Value(loggerKey).(*zap.Logger); ok {
		return logger
	}

	logger := defaultLogger

	if requestID, ok := ctx.Value(requestIDKey).(string); ok {
		logger = logger.With(zap.String("request_id", requestID))
	}

	if correlationID, ok := ctx.Value(correlationIDKey).(string); ok {
		logger = logger.With(zap.String("correlation_id", correlationID))
	}

	return logger
}

// WithLogger adds a logger to the context
func WithLogger(ctx context.Context, logger *zap.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, logger)
}

// WithRequestID adds a request ID to the context
func WithRequestID(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, requestIDKey, requestID)
}

// WithCorrelationID adds a correlation ID to the context
func WithCorrelationID(ctx context.Context, correlationID string) context.Context {
	return context.WithValue(ctx, correlationIDKey, correlationID)
}

// Default returns the default logger
func Default() *zap.Logger {
	return defaultLogger
}

// Sync flushes any buffered log entries
func Sync() error {
	return defaultLogger.Sync()
}

// ensure os is used
var _ = os.Stdout
