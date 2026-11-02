# ─── Stage 1: build ──────────────────────────────────────────────
# Node major as in .nvmrc: Angular 22 refuses to build on Node 20.
FROM node:24-alpine AS build
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
# Unprivileged nginx (uid 101, listens on 8080): nothing in the container runs as root (gaps program security,
# Trivy DS-0002 / triage T-2 closed). PORT CHANGE: the staging image now serves :8080, not :80 — map it with
# `docker run -p 80:8080 …` (or point the staging proxy at :8080).
FROM nginxinc/nginx-unprivileged:1.31-alpine
WORKDIR /usr/share/nginx/html

# The base image's default site listens on 8080 already; ours replaces it.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build --chown=101:101 /app/dist/lascodia-admin/browser/ ./
# A bundle without its shell is not a release.
RUN test -f /usr/share/nginx/html/index.html

# Allow runtime override of API base URL. The entrypoint writes /usr/share/nginx/html/config.json
# from the API_BASE_URL env var (falls back to the bundled public/config.json) — the html directory is owned by
# uid 101 above, so it can, without root.
COPY --chmod=0755 docker/entrypoint.sh /entrypoint.sh

USER 101
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
