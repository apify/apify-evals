# Build context = monorepo root (actor.json dockerContextDir). No agent CLIs
# here: the judge is plain API plumbing plus one LLM call per trace.
FROM apify/actor-node:24 AS builder

COPY --chown=myuser:myuser package*.json ./
COPY --chown=myuser:myuser shared/package*.json ./shared/
COPY --chown=myuser:myuser contract/package*.json ./contract/
COPY --chown=myuser:myuser report/package*.json ./report/
COPY --chown=myuser:myuser actors/runner/package*.json ./actors/runner/
COPY --chown=myuser:myuser actors/workflow-runner/package*.json ./actors/workflow-runner/
COPY --chown=myuser:myuser actors/judge/package*.json ./actors/judge/
COPY --chown=myuser:myuser tools/package*.json ./tools/

RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser tsconfig.base.json ./
COPY --chown=myuser:myuser contract/ ./contract/
COPY --chown=myuser:myuser report/ ./report/
COPY --chown=myuser:myuser actors/judge/ ./actors/judge/

RUN ./node_modules/.bin/tsc -p contract/tsconfig.json \
    && ./node_modules/.bin/tsc -p report/tsconfig.json \
    && ./node_modules/.bin/tsc -p actors/judge/tsconfig.json

FROM apify/actor-node:24

COPY package*.json ./
COPY shared/package*.json ./shared/
COPY contract/package*.json ./contract/
COPY report/package*.json ./report/
COPY actors/runner/package*.json ./actors/runner/
COPY actors/workflow-runner/package*.json ./actors/workflow-runner/
COPY actors/judge/package*.json ./actors/judge/
COPY tools/package*.json ./tools/

RUN npm install --omit=dev --omit=optional --audit=false

COPY --from=builder /usr/src/app/contract/dist ./contract/dist
COPY --from=builder /usr/src/app/report/dist ./report/dist
COPY --from=builder /usr/src/app/report/assets ./report/assets
COPY --from=builder /usr/src/app/actors/judge/dist ./actors/judge/dist
# Suite profiles: fix-area taxonomy the judge may name (read at runtime).
COPY profiles/ ./profiles/

WORKDIR /usr/src/app/actors/judge
CMD ["node", "dist/main.js"]
