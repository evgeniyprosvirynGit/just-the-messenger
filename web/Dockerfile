FROM node:22-alpine AS build

ARG VITE_DEMO_MODE=false
ARG VITE_MAPTILER_API_KEY=
ENV VITE_DEMO_MODE=${VITE_DEMO_MODE}
ENV VITE_MAPTILER_API_KEY=${VITE_MAPTILER_API_KEY}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.29-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
