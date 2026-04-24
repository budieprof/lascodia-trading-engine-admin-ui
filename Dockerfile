# ─── Stage 1: build ──────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
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
