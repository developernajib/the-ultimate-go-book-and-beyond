FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /app/bin/apiserver ./cmd/apiserver

FROM alpine:3.20
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/bin/apiserver /app/bin/apiserver
COPY .env.example .env

EXPOSE 8080

ENTRYPOINT ["/app/bin/apiserver"]
