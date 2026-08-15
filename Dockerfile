# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the production node_modules tree.
RUN npm ci --omit=dev --ignore-scripts

# ---- compiler -------------------------------------------------------------
# The Bicep CLI is fetched once, here, at image build time. The server never downloads a compiler at
# runtime: a control plane that can fetch and execute a binary on demand is a supply-chain hole, no
# matter how it is scoped. Supply BICEP_SHA256 to have the build fail on a digest mismatch.
FROM alpine:3.20 AS compiler
ARG BICEP_VERSION=v0.30.23
ARG BICEP_SHA256=""
# The final sha256sum records the digest of the installed binary so operators can read it out of the
# image and pin BICEP_CLI_SHA256 without trusting a value copied from elsewhere.
RUN apk add --no-cache wget ca-certificates \
    && wget -q -O /tmp/bicep \
      "https://github.com/Azure/bicep/releases/download/${BICEP_VERSION}/bicep-linux-musl-x64" \
    && if [ -n "${BICEP_SHA256}" ]; then \
         echo "${BICEP_SHA256}  /tmp/bicep" | sha256sum -c -; \
       else \
         echo "WARNING: BICEP_SHA256 was not supplied; the downloaded compiler was not verified." >&2; \
       fi \
    && install -m 0555 -o root -g root /tmp/bicep /usr/local/bin/bicep \
    && rm /tmp/bicep \
    && sha256sum /usr/local/bin/bicep | cut -d' ' -f1 > /usr/local/share/bicep.sha256

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# The Bicep CLI is a self-contained .NET binary. On musl it needs ICU and the C++ runtime, and
# without them it does not fail gracefully — it aborts on startup with "Couldn't find a valid ICU
# package". Invariant globalization would also silence that, but it changes string comparison and
# casing semantics inside a template compiler, so the real libraries are installed instead.
RUN apk add --no-cache icu-libs icu-data-full libstdc++ libgcc

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json server.json ./

# Read-only and owned by root, so a compromised process cannot replace the compiler it is about to
# execute.
COPY --from=compiler --chown=root:root /usr/local/bin/bicep /usr/local/bin/bicep
COPY --from=compiler --chown=root:root /usr/local/share/bicep.sha256 /usr/local/share/bicep.sha256
RUN chmod 0555 /usr/local/bin/bicep

# Compilation happens in a private temporary directory owned by this user; nothing in /app is
# writable by it.
USER node
EXPOSE 8080

ARG GIT_SHA=unknown
ARG SERVICE_VERSION=0.0.0
ENV GIT_SHA=${GIT_SHA} \
    SERVICE_VERSION=${SERVICE_VERSION} \
    BICEP_CLI_PATH=/usr/local/bin/bicep

LABEL org.opencontainers.image.source="https://github.com/ashergarland/agent-tool-server-azure" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${SERVICE_VERSION}"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/index.js"]
