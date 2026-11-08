FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN mkdir -p /app/runtime-server && tar -C /app --exclude=server/tests -cf /tmp/server-runtime.tar server && tar -xf /tmp/server-runtime.tar -C /app/runtime-server --strip-components=1 && rm /tmp/server-runtime.tar

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/runtime-server ./server
COPY --from=build /app/dist ./dist
EXPOSE 10000
CMD ["npm","start"]
