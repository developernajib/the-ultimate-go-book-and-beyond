// internal/metrics/prometheus.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // HTTP metrics
    HTTPRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "socialnet_http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )

    HTTPRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "socialnet_http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path"},
    )

    // Database metrics
    DBQueriesTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "socialnet_db_queries_total",
            Help: "Total number of database queries",
        },
        []string{"operation", "table"},
    )

    DBQueryDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "socialnet_db_query_duration_seconds",
            Help:    "Database query duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"operation", "table"},
    )

    // Business metrics
    PostsCreatedTotal = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "socialnet_posts_created_total",
            Help: "Total number of posts created",
        },
    )

    UsersRegisteredTotal = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "socialnet_users_registered_total",
            Help: "Total number of users registered",
        },
    )

    FollowsTotal = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "socialnet_follows_total",
            Help: "Total number of follow actions",
        },
    )

    // Cache metrics
    CacheHitsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "socialnet_cache_hits_total",
            Help: "Total number of cache hits",
        },
        []string{"cache_type"},
    )

    CacheMissesTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "socialnet_cache_misses_total",
            Help: "Total number of cache misses",
        },
        []string{"cache_type"},
    )
)
