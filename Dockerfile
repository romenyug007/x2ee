FROM node:22-alpine
WORKDIR /app
COPY . .
RUN node build-client.mjs
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
