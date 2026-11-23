# One image, two roles (see render.yaml / docker-compose.yml):
#   app:      pnpm --filter @livepage/server start   (web app + API + live sync on one port)
#   sandbox:  pnpm --filter @livepage/sandbox start  (HTML block runner, deploy on a different domain)
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @livepage/web build
ENV NODE_ENV=production
EXPOSE 1234 5174
CMD ["pnpm", "--filter", "@livepage/server", "start"]
