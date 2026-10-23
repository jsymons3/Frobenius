FROM node:22.22.0-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY bin ./bin
# Supply the selected network's public genesis at runtime, mounted read-only.
# No network identity or validator key is baked into this image.

ENV NODE_ENV=production \
    FROBENIUS_GENESIS=/etc/frobenius/genesis.json \
    FROBENIUS_DATA_DIR=/var/data/frobenius \
    FROBENIUS_HOST=0.0.0.0 \
    PORT=8800 \
    FROBENIUS_DROP_PRIVILEGES=1
EXPOSE 8800

# Configure with FROBENIUS_PEERS (comma-separated URLs), FROBENIUS_PUBLIC_URL, and, for a
# validator, FROBENIUS_VALIDATOR_SEED. The process starts as root only to prepare the
# mounted data directory, then becomes uid 1000 before opening the database.
CMD ["node", "--disable-warning=ExperimentalWarning", "bin/frob.mjs", "node"]
