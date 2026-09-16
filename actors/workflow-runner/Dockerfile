# Build context = monorepo root (actor.json dockerContextDir), so the
# @apify-evals/contract workspace package is available to the build.
FROM apify/actor-node:24 AS builder

# Manifests for every workspace listed in the root package.json, so npm can
# resolve the workspace graph; only contract + this actor get built.
COPY --chown=myuser:myuser package*.json ./
COPY --chown=myuser:myuser shared/package*.json ./shared/
COPY --chown=myuser:myuser contract/package*.json ./contract/
COPY --chown=myuser:myuser actors/runner/package*.json ./actors/runner/
COPY --chown=myuser:myuser actors/workflow-runner/package*.json ./actors/workflow-runner/
COPY --chown=myuser:myuser actors/judge/package*.json ./actors/judge/
COPY --chown=myuser:myuser tools/package*.json ./tools/

RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser tsconfig.base.json ./
COPY --chown=myuser:myuser contract/ ./contract/
COPY --chown=myuser:myuser actors/workflow-runner/ ./actors/workflow-runner/

RUN ./node_modules/.bin/tsc -p contract/tsconfig.json \
    && ./node_modules/.bin/tsc -p actors/workflow-runner/tsconfig.json

FROM apify/actor-node:24

USER root
RUN apk add --no-cache curl bash git jq ca-certificates

RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp /root/.local/bin/claude /usr/local/bin/claude \
    && chmod 755 /usr/local/bin/claude \
    && claude --version

RUN npm install --global @openai/codex@0.154.0 --audit=false \
    && codex --version

COPY package*.json ./
COPY shared/package*.json ./shared/
COPY contract/package*.json ./contract/
COPY actors/runner/package*.json ./actors/runner/
COPY actors/workflow-runner/package*.json ./actors/workflow-runner/
COPY actors/judge/package*.json ./actors/judge/
COPY tools/package*.json ./tools/

RUN npm install --omit=dev --omit=optional --audit=false && rm -rf /root/.npm

COPY --from=builder /usr/src/app/contract/dist ./contract/dist
COPY --from=builder /usr/src/app/actors/workflow-runner/dist ./actors/workflow-runner/dist

RUN chown -R root:root /usr/src/app && chmod -R 755 /usr/src/app \
    && mkdir -p /home/myuser/.codex && chown -R myuser:myuser /home/myuser

USER myuser
ENV CODEX_HOME=/home/myuser/.codex
WORKDIR /usr/src/app/actors/workflow-runner
CMD ["node", "dist/main.js"]
