# FraudShield API (Node.js). The test suite is included so the Test Runner page can run it.
FROM node:22.11.0-alpine
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY backend/ ./
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=5 CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "src/server.js"]
