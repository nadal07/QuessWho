FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 7429

ENV PORT=7429
ENV NODE_ENV=production

CMD ["node", "server.js"]
