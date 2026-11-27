# syntax=docker/dockerfile:1

# ---- build stage: compile the ingester against the whole backend module ----
FROM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ingester ./ingester

# ---- runtime stage: distroless static (nonroot, CA certs) ----
# The static distroless image ships CA certificates, which the ingester needs
# for ESPN HTTPS, Neon TLS, and the R2 S3 endpoint.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
WORKDIR /
COPY --from=build /out/ingester /ingester

# Outbound-only worker: no port is exposed.
USER nonroot:nonroot
ENTRYPOINT ["/ingester"]
