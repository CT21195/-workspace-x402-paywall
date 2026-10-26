FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund
COPY server.js ./
ENV PORT=3402
EXPOSE 3402
CMD ["node", "server.js"]
