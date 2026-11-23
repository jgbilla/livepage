FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
ARG VITE_COLLAB_URL=ws://localhost:1234
ARG VITE_SANDBOX_URL=http://localhost:5174
ENV VITE_COLLAB_URL=$VITE_COLLAB_URL VITE_SANDBOX_URL=$VITE_SANDBOX_URL
RUN pnpm install --frozen-lockfile && pnpm --filter @livepage/web build
