# A static site, so there is nothing to build — just nginx and four files.
#
# nginx-unprivileged runs as a non-root user and listens on 8080, which lets
# the container run with a read-only root filesystem and no capabilities.
FROM nginxinc/nginx-unprivileged:1.27-alpine

LABEL org.opencontainers.image.title="photo-sheet-printer" \
      org.opencontainers.image.description="Arrange photos into a printable grid and export a PDF with the original image data embedded untouched." \
      org.opencontainers.image.licenses="MIT"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY public/           /usr/share/nginx/html/

EXPOSE 8080

# busybox wget ships with the alpine image; there is no curl.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
