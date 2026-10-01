FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data TRUST_PROXY=1
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8787
CMD ["node", "server.js"]
