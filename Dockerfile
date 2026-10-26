FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "--no-warnings", "src/server.js"]
