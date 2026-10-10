// internal/logging/logger.go
package logging

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

func NewLogger(environment string) (*zap.Logger, error) {
    var config zap.Config

    if environment == "production" {
        config = zap.NewProductionConfig()
        config.EncoderConfig.TimeKey = "timestamp"
        config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    } else {
        config = zap.NewDevelopmentConfig()
        config.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
    }

    config.Level = zap.NewAtomicLevelAt(zap.InfoLevel)

    return config.Build()
}
