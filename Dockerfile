FROM node:24-bookworm-slim AS build
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) asset="c2pa-node_x86_64-unknown-linux-gnu-v0.10.0.zip"; digest="4da99fadf6caef86c9cc4a3ee3e126672c19e4f0dba2e2a0f81d4e0cfc691cfa" ;; \
      arm64) asset="c2pa-node_aarch64-unknown-linux-gnu-v0.10.0.zip"; digest="26eb6ec9ffe1ad80a02aad6b4e5cae545b32f09e3050cc4a0e7076d4bf0960ba" ;; \
      *) echo "Unsupported C2PA Node binary architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/c2pa; \
    url="https://github.com/contentauth/c2pa-js/releases/download/%40contentauth%2Fc2pa-node%400.10.0/${asset}"; \
    curl --fail --location --retry 5 --retry-all-errors --connect-timeout 20 --max-time 300 "$url" --output /tmp/c2pa-node.zip; \
    echo "$digest  /tmp/c2pa-node.zip" | sha256sum --check -; \
    entry="$(unzip -Z1 /tmp/c2pa-node.zip | head -n 1)"; \
    test -n "$entry"; \
    unzip -p /tmp/c2pa-node.zip "$entry" > /opt/c2pa/index.node; \
    test -s /opt/c2pa/index.node; \
    chmod 0644 /opt/c2pa/index.node; \
    rm /tmp/c2pa-node.zip
ENV C2PA_LIBRARY_PATH=/opt/c2pa/index.node
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN mkdir -p /app/runtime-server && tar -C /app --exclude=server/tests -cf /tmp/server-runtime.tar server && if tar -tf /tmp/server-runtime.tar | grep -q '^server/tests/'; then echo 'Test fixtures must not enter the runtime image' >&2; exit 1; fi && tar -xf /tmp/server-runtime.tar -C /app/runtime-server --strip-components=1 && rm /tmp/server-runtime.tar

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV C2PA_LIBRARY_PATH=/opt/c2pa/index.node
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /opt/c2pa /opt/c2pa
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/runtime-server ./server
COPY --from=build /app/dist ./dist
EXPOSE 10000
CMD ["npm","start"]
