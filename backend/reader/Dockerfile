# syntax=docker/dockerfile:1

# ---- build stage: compile the reader against the whole backend module ----
FROM golang:1.26-alpine AS build
WORKDIR /src

# Leverage layer caching: deps first, then source.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static, stripped, reproducible binary. competitions.json is //go:embed-ed,
# so it is baked into the binary here — no runtime file needed.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/reader ./reader

# ---- runtime stage: distroless static (nonroot, CA certs, ~2 MB base) ----
# The static distroless image ships CA certificates, which the reader needs for
# Neon TLS (sslmode=require) and the ESPN news proxy.
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/reader /reader

# The reader reads PORT (default 8080) and listens on :$PORT.
ENV PORT=8080
EXPOSE 8080

USER nonroot:nonroot
ENTRYPOINT ["/reader"]
