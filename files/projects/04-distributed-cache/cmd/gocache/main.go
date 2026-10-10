// cmd/gocache/main.go
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"gocache/internal/server"
)

func main() {
	addr := flag.String("addr", ":6379", "Server address")
	maxMemory := flag.Int64("maxmemory", 1024*1024*1024, "Max memory in bytes (default 1GB)")

	flag.Parse()

	srv := server.NewServer(*addr, *maxMemory)

	if err := srv.Start(); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}

	// Wait for interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	<-sigChan

	fmt.Println("\nShutting down server...")
	if err := srv.Stop(); err != nil {
		log.Fatalf("Error shutting down: %v", err)
	}

	fmt.Println("Server stopped")
}
