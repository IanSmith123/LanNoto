FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS frontend
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26.10-bookworm AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY --from=frontend /src/internal/webassets/dist/ internal/webassets/dist/
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" GOARM="${TARGETVARIANT#v}" \
    go build -trimpath -ldflags="-s -w" -o /out/lannoto ./cmd/lannoto

FROM alpine:3.24 AS slim
RUN mkdir /workspace && touch /workspace/.keep && chown -R 10001:10001 /workspace
COPY --from=backend /out/lannoto /usr/local/bin/lannoto
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/lannoto/
COPY licenses/THIRD_PARTY.txt /usr/share/doc/lannoto/licenses/
WORKDIR /workspace
ENV HOME=/workspace
USER 10001:10001
RUN lannoto -h
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/lannoto"]

FROM debian:trixie-slim AS with-pandoc
RUN apt-get update \
    && apt-get install -y --no-install-recommends pandoc \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 10001 -g 10001 /workspace \
    && install -o 10001 -g 10001 /dev/null /workspace/.keep
COPY --from=backend /out/lannoto /usr/local/bin/lannoto
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/lannoto/
COPY licenses/THIRD_PARTY.txt /usr/share/doc/lannoto/licenses/
WORKDIR /workspace
ENV HOME=/workspace
USER 10001:10001
RUN lannoto -h \
    && printf '# LanNoto\n' | pandoc --from=gfm+tex_math_dollars --to=json --sandbox -o /tmp/lannoto.json \
    && pandoc --from=json --to=docx --no-highlight --fail-if-warnings -o /tmp/lannoto.docx /tmp/lannoto.json \
    && rm /tmp/lannoto.json /tmp/lannoto.docx
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/lannoto"]
