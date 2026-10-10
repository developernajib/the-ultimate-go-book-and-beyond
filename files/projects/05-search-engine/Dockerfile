# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.27.1-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" \
    -o /bin/gosearch ./cmd/server

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache wget ca-certificates

COPY --from=builder /bin/gosearch /bin/gosearch

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

ENTRYPOINT ["/bin/gosearch"]
