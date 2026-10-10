# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.27.1-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" \
    -o /bin/api ./cmd/api

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata wget

COPY --from=builder /bin/api /bin/api

EXPOSE 8080

ENTRYPOINT ["/bin/api"]
