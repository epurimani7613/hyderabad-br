# Hyderabad BR - authoritative game server + static client in one image.
#
# The WebSocket server and the static client MUST ship together: the client
# connects back to the same origin, and the server also serves client/public/.
# Splitting them would need CORS plus a separate WS host.

# --- stage 1: build the client bundle -------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund          # needs esbuild, so devDeps too
COPY shared/ ./shared/
COPY client/src/ ./client/src/
COPY tools/build-client.mjs ./tools/build-client.mjs
RUN node tools/build-client.mjs

# --- stage 2: runtime -----------------------------------------------------
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY shared/ ./shared/
COPY server/ ./server/
# Bundle comes from the build stage; index.html/style.css are committed sources.
COPY client/public/ ./client/public/
COPY --from=build /app/client/public/bundle.js ./client/public/bundle.js
COPY data/baked/ ./data/baked/

ENV NODE_ENV=production \
    PORT=8080 \
    BOT_TOTAL=24

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# One process serves static files, the WebSocket endpoint and the match loop.
CMD ["node", "server/index.mjs"]