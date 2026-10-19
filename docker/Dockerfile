# Production image: the compiled Bun binary on a slim Debian base.
# Build the binary first (CI does this): `bun run compile linux-x64-baseline --no-version-tag`
# → build/bin/leicraft-client-api-linux-x64-baseline. The name must match AppConstants.BINARY_NAME
# (src/utils/constants.ts).
# Layout: binary under app/, data/ (DB, logs, uploaded assets) and config/ are volumes beside it.
# The binary embeds the Drizzle migrations (--asset) and applies them on startup while
# LCC_DB_AUTO_MIGRATE is true. Runtime config: LCC_* env (see example.env).
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/leicraftmc/leicraft-client-api

COPY ./build/bin/leicraft-client-api-linux-x64-baseline /opt/leicraftmc/leicraft-client-api/app/leicraft-client-api
# migrations are embedded in the binary, we do not need to copy them

RUN chmod u+x /opt/leicraftmc/leicraft-client-api/app/leicraft-client-api

EXPOSE 12550/tcp

ENV NODE_ENV=production

ENV LCC_API_HOST=::
ENV LCC_API_PORT=12550

ENV LCC_DB_PATH=/opt/leicraftmc/leicraft-client-api/data/db.sqlite
ENV LCC_DB_AUTO_MIGRATE=true
# LCC_DB_MIGRATION_DIR does not need to be set, the binary embeds the migrations

ENV LCC_LOG_DIR=/opt/leicraftmc/leicraft-client-api/data/logs
ENV LCC_CONFIG_BASE_DIR=/opt/leicraftmc/leicraft-client-api/config
ENV LCC_ASSETS_DIR=/opt/leicraftmc/leicraft-client-api/data/assets


VOLUME /opt/leicraftmc/leicraft-client-api/data
VOLUME /opt/leicraftmc/leicraft-client-api/config

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
	CMD curl -f http://localhost:12550/health || exit 1

ENTRYPOINT ["/opt/leicraftmc/leicraft-client-api/app/leicraft-client-api"]
