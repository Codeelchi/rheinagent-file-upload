# syntax=docker/dockerfile:1

# --- build stage: compiles TypeScript, needs devDependencies -------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server.ts dataplane.ts ./
COPY src ./src
RUN npm run build

# --- runtime stage: production dependencies only, no TypeScript/tsx ------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S rheinagent && adduser -S rheinagent -G rheinagent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# data/ is the only writable path (see RHEINAGENT_FILE_UPLOAD_* env vars in
# docs/INSTALLATION.md) — created here so the non-root user owns it before
# a volume is mounted over it; --read-only at `docker run`/compose level
# still works since nothing else under /app is ever written to.
RUN mkdir -p /app/data && chown -R rheinagent:rheinagent /app/data
USER rheinagent

# No EXPOSE/CMD here on purpose — control and data plane are two separate
# processes from the same image (see docker-compose.yml), each binding a
# different port; a single fixed CMD/EXPOSE would misrepresent that.
