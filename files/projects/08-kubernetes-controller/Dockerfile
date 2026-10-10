FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /app/bin/manager ./cmd/main

FROM alpine:3.20
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/bin/manager /app/bin/manager

USER 65532:65532

ENTRYPOINT ["/app/bin/manager"]
