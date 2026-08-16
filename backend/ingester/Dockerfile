# syntax=docker/dockerfile:1

# ---- build stage: compile the ingester against the whole backend module ----
FROM golang:1.26-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ingester ./ingester

# ---- runtime stage: distroless static (nonroot, CA certs) ----
# The static distroless image ships CA certificates, which the ingester needs
# for ESPN HTTPS, Neon TLS, and the R2 S3 endpoint.
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/ingester /ingester

# Outbound-only worker: no port is exposed.
USER nonroot:nonroot
ENTRYPOINT ["/ingester"]
