# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.27.1-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" \
    -o /bin/gocache ./cmd/gocache

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM scratch

COPY --from=builder /bin/gocache /bin/gocache

EXPOSE 6379 2112

ENTRYPOINT ["/bin/gocache"]
