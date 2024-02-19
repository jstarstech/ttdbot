FROM node:18-alpine as builder
WORKDIR /app

COPY package*.json ./

RUN npm install -D

COPY . .

RUN npm run build

FROM node:18-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY --from=builder /app/dist/ /app

RUN mkdir data

VOLUME ["/app/data/"]
CMD ["node", "main.js"]
