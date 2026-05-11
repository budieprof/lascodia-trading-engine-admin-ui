# ─── Stage 1: build ──────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Build-time metadata baked into public/config.json so the runtime image
# carries its own build identity even when the operator doesn't pass any
# env vars at `docker run` time. The footer version pill reads buildSha
# from config.json (or falls back to the entrypoint-rewritten value when
# the operator does pass BUILD_SHA at runtime).
ARG BUILD_SHA=
ARG BUILD_TIME=

COPY package.json package-lock.json* ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .

# Inject build SHA + timestamp into public/config.json before the bundle
# is built. node -e is used over sed so the JSON stays valid regardless
# of which keys already exist. No-op if both args are empty (local dev).
# ARG values must be forwarded as env vars explicitly — bare ARGs aren't
# visible inside the spawned node process.
RUN if [ -n "$BUILD_SHA" ] || [ -n "$BUILD_TIME" ]; then \
      BUILD_SHA="$BUILD_SHA" BUILD_TIME="$BUILD_TIME" \
        node -e "const fs=require('fs');const p='public/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));if(process.env.BUILD_SHA)c.buildSha=process.env.BUILD_SHA;if(process.env.BUILD_TIME)c.buildTime=process.env.BUILD_TIME;fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');" ; \
    fi
RUN npm run build -- --configuration production

# ─── Stage 2: runtime ────────────────────────────────────────────
FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

# Clear nginx defaults and drop in our SPA-friendly config.
RUN rm -rf ./*
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/lascodia-admin/browser/ ./

# Allow runtime override of API base URL. The entrypoint writes /usr/share/nginx/html/config.json
# from the API_BASE_URL env var (falls back to the bundled public/config.json).
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
