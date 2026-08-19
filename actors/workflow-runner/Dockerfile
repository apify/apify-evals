FROM apify/actor-node:24

USER root
RUN apk add --no-cache curl bash git jq ca-certificates

RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp /root/.local/bin/claude /usr/local/bin/claude \
    && chmod 755 /usr/local/bin/claude \
    && claude --version

COPY package*.json ./
RUN npm install --omit=dev --omit=optional --audit=false && rm -rf /root/.npm

COPY . ./
RUN chown -R root:root /usr/src/app && chmod -R 755 /usr/src/app \
    && mkdir -p /home/myuser && chown myuser:myuser /home/myuser

USER myuser
CMD ["node", "src/main.js"]
