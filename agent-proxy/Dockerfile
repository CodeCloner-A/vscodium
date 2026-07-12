# VSCodium Agent Proxy – dependency-frei, daher kein npm install nötig.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
USER node
CMD ["node", "server.js"]
