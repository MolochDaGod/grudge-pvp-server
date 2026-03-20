FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js .
EXPOSE 5000
CMD ["node", "index.js"]
