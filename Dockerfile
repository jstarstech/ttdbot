FROM node:22.12.0-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/core/package*.json ./packages/core/

RUN npm ci

COPY . .

RUN npm run build

FROM node:22.12.0-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
COPY packages/core/package*.json ./packages/core/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/core/dist/ ./packages/core/dist/

RUN mkdir -p data

VOLUME ["/app/data/"]
CMD ["npm", "start", "--workspace=core"]
