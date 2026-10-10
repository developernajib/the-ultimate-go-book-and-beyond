// internal/observability/logger.go
package observability

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

// NewLogger creates a configured logger
func NewLogger(level, format, output string) (*zap.Logger, error) {
    var zapLevel zapcore.Level
    if err := zapLevel.UnmarshalText([]byte(level)); err != nil {
        zapLevel = zapcore.InfoLevel
    }

    config := zap.Config{
        Level:            zap.NewAtomicLevelAt(zapLevel),
        Development:      false,
        Encoding:         format,
        EncoderConfig:    zap.NewProductionEncoderConfig(),
        OutputPaths:      []string{output},
        ErrorOutputPaths: []string{"stderr"},
    }

    if format == "console" {
        config.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
        config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    }

    return config.Build()
}
