# Caddy with the DuckDNS DNS-01 module, so the certificate for the DuckDNS name is obtained without
# opening port 80. Multi-arch (amd64 on the PC, arm64 on the Raspberry Pi) because both base images are.
# Pinned by digest and plugin version (security audit 2026-11-09, L1): this image holds the TLS key and the
# DuckDNS token. Refresh the digests deliberately: docker buildx imagetools inspect caddy:2 --format '{{.Manifest.Digest}}'
FROM caddy:2-builder@sha256:6350162b3889ca32600b3c699c61572fa0eb3ad6b2a51874f19b158a7df77511 AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns@v0.5.0

FROM caddy:2@sha256:ce773ec7a742ce15ee6bf2bb5f65882b9e2a4487b10733e6f1484f86e6b5d8bc
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
