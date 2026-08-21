# Multi-stage build (PLAN.md → Hosting): stage 1 builds the static client,
# stage 2 is the one Node process that serves those statics AND hosts the ws
# rooms on $PORT. common/ ships as raw TS on both stages — the server runs
# through tsx, so nothing is ever compiled twice into disagreement.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY common/package.json common/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci
COPY tsconfig.base.json ./
COPY common ./common
COPY client ./client
COPY server ./server
RUN npm run build -w client

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY common/package.json common/
COPY client/package.json client/
COPY server/package.json server/
# Production deps only: server needs ws + tsx, common is a workspace link.
RUN npm ci --omit=dev
COPY common ./common
COPY server ./server
# The built client lands where server/src/statics.ts resolves ../../client/dist.
COPY --from=build /app/client/dist ./client/dist
EXPOSE 8080
CMD ["npm", "run", "start", "-w", "server"]
