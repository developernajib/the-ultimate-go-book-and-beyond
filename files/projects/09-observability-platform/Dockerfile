FROM golang:1.27.1-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /app/bin/observability ./cmd/observability

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/bin/observability /app/bin/observability
COPY configs/ /app/configs/

EXPOSE 8080 9090 9100 4317 4318

ENTRYPOINT ["/app/bin/observability", "-config", "configs/config.yaml"]
