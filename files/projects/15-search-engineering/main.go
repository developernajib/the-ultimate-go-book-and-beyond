package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/search-engineering/internal/api"
	"github.com/example/search-engineering/internal/index"
)

func main() {
	idx := index.NewInvertedIndex()

	// Example: index a few documents
	idx.IndexDocument(index.Document{
		ID: 1,
		Fields: map[string]string{
			"title": "Introduction to Go Programming",
			"body":  "Go is a statically typed compiled language designed at Google.",
			"tags":  "golang programming",
		},
	})
	idx.IndexDocument(index.Document{
		ID: 2,
		Fields: map[string]string{
			"title": "Concurrency in Go",
			"body":  "Goroutines and channels are the foundation of Go concurrency.",
			"tags":  "golang concurrency goroutines",
		},
	})

	srv := api.NewSearchServer(idx)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := ":" + port

	httpServer := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		fmt.Printf("Search engine listening on %s\n", addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Printf("server error: %v\n", err)
		}
	}()

	<-stop
	fmt.Println("Shutting down search engine...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		fmt.Printf("shutdown error: %v\n", err)
	}
	fmt.Println("Search engine stopped.")
}
