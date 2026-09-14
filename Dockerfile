# The Hexagon — zero npm dependencies, so this is just Node plus the source.
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
# There is nothing to install; the RUN is here so the layer exists if a dependency is ever added.
RUN [ -f package-lock.json ] && npm ci --omit=dev || true

COPY src ./src
COPY tools ./tools
COPY public ./public
COPY server.js ./
# The Ask panel's docs tool searches these (src/ask-tools.js). Without them it says so and answers
# from the live tools alone.
COPY README.md ./
COPY ops/DEPLOY.md ./ops/

# The journals, tick tape and ledger live here. Mount a volume on it or a restart loses the
# evidence the desk exists to collect.
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

# Paper by default and bound to every interface, because in a container the only route in is the
# port the host maps. server.js refuses to start on a non-loopback bind unless DASH_PASS is set.
ENV MODE=paper
ENV BIND_HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

# No credentials are baked in and none are needed: the Kalshi key is only ever read in live mode.
CMD ["node", "server.js"]
