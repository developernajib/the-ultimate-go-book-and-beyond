FROM golang:1.27.1-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /app/bin/gateway ./cmd/gateway

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/bin/gateway /app/bin/gateway
COPY configs/ /app/configs/

EXPOSE 8080 9090

ENTRYPOINT ["/app/bin/gateway", "--config", "configs/gateway.yaml"]
