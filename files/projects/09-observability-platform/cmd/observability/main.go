// cmd/observability/main.go
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/observability-platform/pkg/alerting"
	"github.com/example/observability-platform/pkg/config"
	logsingestion "github.com/example/observability-platform/pkg/ingestion/logs"
	"github.com/example/observability-platform/pkg/ingestion/otlp"
	"github.com/example/observability-platform/pkg/ingestion/prometheus"
	"github.com/example/observability-platform/pkg/ingestion/statsd"
	"github.com/example/observability-platform/pkg/models"
	"github.com/example/observability-platform/pkg/pipeline"
	"github.com/example/observability-platform/pkg/query"
	logsstorage "github.com/example/observability-platform/pkg/storage/logs"
	"github.com/example/observability-platform/pkg/storage/metrics"
	"github.com/example/observability-platform/pkg/storage/traces"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("loading config: %v", err)
	}

	metricStore, err := metrics.NewPrometheusStore(
		cfg.Storage.Metrics.Path,
		cfg.Storage.Metrics.RetentionTime,
	)
	if err != nil {
		log.Fatalf("creating metric store: %v", err)
	}
	defer metricStore.Close()

	logStore, err := logsstorage.NewClickHouseStore(
		cfg.Storage.Logs.DSN,
		cfg.Storage.Logs.Database,
		cfg.Storage.Logs.Table,
	)
	if err != nil {
		log.Fatalf("creating log store: %v", err)
	}
	defer logStore.Close()

	traceStore, err := traces.NewClickHouseStore(
		cfg.Storage.Traces.DSN,
		cfg.Storage.Traces.Database,
		cfg.Storage.Traces.SpansTable,
		cfg.Storage.Traces.IndexTable,
	)
	if err != nil {
		log.Fatalf("creating trace store: %v", err)
	}
	defer traceStore.Close()

	pipelineCfg := pipeline.PipelineConfig{
		Workers:       cfg.Ingestion.Workers,
		BufferSize:    cfg.Ingestion.BufferSize,
		FlushInterval: cfg.Ingestion.FlushInterval,
		MaxBatchSize:  cfg.Ingestion.MaxBatchSize,
	}

	pipe := pipeline.NewPipeline(pipelineCfg, metricStore, logStore, traceStore)

	pipe.AddValidator(&pipeline.BasicValidator{})
	pipe.AddEnricher(&pipeline.LabelEnricher{
		Labels: models.Labels{
			{Name: "platform", Value: "observability"},
		},
	})

	if err := pipe.Start(context.Background()); err != nil {
		log.Fatalf("starting pipeline: %v", err)
	}
	defer pipe.Stop(context.Background())

	if cfg.Ingestion.OTLP.Enabled {
		otlpReceiver := otlp.NewReceiver(cfg.Ingestion.OTLP.GRPCAddr, pipe)
		if err := otlpReceiver.Start(context.Background()); err != nil {
			log.Fatalf("starting OTLP receiver: %v", err)
		}
		defer otlpReceiver.Stop(context.Background())
	}

	if cfg.Ingestion.Prometheus.Enabled {
		targets := []*prometheus.Target{}
		promScraper := prometheus.NewScraper(targets, pipe)
		if err := promScraper.Start(context.Background()); err != nil {
			log.Fatalf("starting Prometheus scraper: %v", err)
		}
		defer promScraper.Stop(context.Background())
	}

	if cfg.Ingestion.StatsD.Enabled {
		statsdReceiver := statsd.NewReceiver(
			cfg.Ingestion.StatsD.UDPAddr,
			cfg.Ingestion.StatsD.TCPAddr,
			pipe,
		)
		if err := statsdReceiver.Start(context.Background()); err != nil {
			log.Fatalf("starting StatsD receiver: %v", err)
		}
		defer statsdReceiver.Stop(context.Background())
	}

	if cfg.Ingestion.Logs.Enabled {
		logCollector := logsingestion.NewCollector(
			cfg.Ingestion.Logs.SyslogAddr,
			cfg.Ingestion.Logs.FilePaths,
			cfg.Ingestion.Logs.ParseJSON,
			pipe,
		)
		if err := logCollector.Start(context.Background()); err != nil {
			log.Fatalf("starting log collector: %v", err)
		}
		defer logCollector.Stop(context.Background())
	}

	queryEngine := query.NewEngine(
		metricStore,
		cfg.Query.MaxSamples,
		cfg.Query.QueryTimeout,
	)

	if cfg.Alerting.Enabled {
		alertEngine := alerting.NewEngine(queryEngine, cfg.Alerting.EvaluationInterval)

		if err := alertEngine.LoadRules(cfg.Alerting.RulesFile); err != nil {
			log.Fatalf("loading alert rules: %v", err)
		}

		if err := alertEngine.Start(context.Background()); err != nil {
			log.Fatalf("starting alert engine: %v", err)
		}
		defer alertEngine.Stop(context.Background())
	}

	http.HandleFunc("/api/v1/query", handleQuery(queryEngine))
	http.HandleFunc("/api/v1/query_range", handleQueryRange(queryEngine))
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/metrics", handleMetrics(pipe))

	server := &http.Server{
		Addr:         cfg.Server.HTTPAddr,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	go func() {
		log.Printf("Starting HTTP server on %s", cfg.Server.HTTPAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down gracefully...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.Server.GracefulTimeout)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP server shutdown error: %v", err)
	}

	log.Println("Shutdown complete")
}

func handleQuery(engine *query.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		queryStr := r.URL.Query().Get("query")
		if queryStr == "" {
			http.Error(w, "query parameter required", http.StatusBadRequest)
			return
		}

		timestamp := time.Now()
		if t := r.URL.Query().Get("time"); t != "" {
			parsed, err := time.Parse(time.RFC3339, t)
			if err == nil {
				timestamp = parsed
			}
		}

		result, err := engine.Query(r.Context(), queryStr, timestamp)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}

func handleQueryRange(engine *query.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		queryStr := r.URL.Query().Get("query")
		if queryStr == "" {
			http.Error(w, "query parameter required", http.StatusBadRequest)
			return
		}

		start, _ := time.Parse(time.RFC3339, r.URL.Query().Get("start"))
		end, _ := time.Parse(time.RFC3339, r.URL.Query().Get("end"))
		step, _ := time.ParseDuration(r.URL.Query().Get("step"))

		if start.IsZero() || end.IsZero() || step == 0 {
			http.Error(w, "start, end, and step parameters required", http.StatusBadRequest)
			return
		}

		result, err := engine.QueryRange(r.Context(), queryStr, start, end, step)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func handleMetrics(pipe *pipeline.Pipeline) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stats := pipe.Stats()

		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "# HELP metrics_processed_total Total metrics processed\n")
		fmt.Fprintf(w, "# TYPE metrics_processed_total counter\n")
		fmt.Fprintf(w, "metrics_processed_total %d\n", stats.MetricsProcessed)

		fmt.Fprintf(w, "# HELP logs_processed_total Total logs processed\n")
		fmt.Fprintf(w, "# TYPE logs_processed_total counter\n")
		fmt.Fprintf(w, "logs_processed_total %d\n", stats.LogsProcessed)

		fmt.Fprintf(w, "# HELP traces_processed_total Total traces processed\n")
		fmt.Fprintf(w, "# TYPE traces_processed_total counter\n")
		fmt.Fprintf(w, "traces_processed_total %d\n", stats.TracesProcessed)
	}
}
