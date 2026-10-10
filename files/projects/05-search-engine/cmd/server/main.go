// cmd/server/main.go
package main

import (
	"context"
	"errors"
	"flag"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/search-engine/internal/analyzer"
	"github.com/example/search-engine/internal/api/rest"
	"github.com/example/search-engine/internal/index/inverted"
	"github.com/example/search-engine/internal/query/executor"
	"github.com/example/search-engine/internal/ranking"
	"go.uber.org/zap"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP server address")
	flag.Parse()

	// Setup logger
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	// Create index
	logger.Info("Initializing search engine")
	index := inverted.NewInvertedIndex(analyzer.NewEnglishAnalyzer())

	// Create scorer and executor
	scorer := ranking.NewBM25Scorer(index)
	exec := executor.NewExecutor(index, scorer)

	// Start REST API server
	server := rest.NewServer(*addr, exec, index, logger)

	// Handle graceful shutdown
	go func() {
		if err := server.Start(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatal("Server failed", zap.Error(err))
		}
	}()

	logger.Info("GoSearch server started", zap.String("addr", *addr))

	// Wait for interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	logger.Info("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Error("Server shutdown failed", zap.Error(err))
	}

	logger.Info("Server stopped")
}
