FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/bin/trader ./cmd/trader

FROM alpine:3.20
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/bin/trader /app/bin/trader
COPY .env.example .env

EXPOSE 9090

ENTRYPOINT ["/app/bin/trader"]
