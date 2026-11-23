# Build context = monorepo root (actor.json dockerContextDir), so the
# @apify-evals/contract workspace package is available to the build.
FROM apify/actor-node:24 AS builder

# Manifests for every workspace listed in the root package.json, so npm can
# resolve the workspace graph; only contract + this actor get built.
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
COPY --chown=myuser:myuser actors/workflow-runner/ ./actors/workflow-runner/

RUN ./node_modules/.bin/tsc -p contract/tsconfig.json \
    && ./node_modules/.bin/tsc -p actors/workflow-runner/tsconfig.json

FROM apify/actor-node:24

USER root
RUN apk add --no-cache curl bash git jq ca-certificates

# Pinned: the agent version is part of the measurement. Bump deliberately and mark the day in the report.
RUN npm install --global @anthropic-ai/claude-code@2.1.300 --audit=false \
    && claude --version

RUN npm install --global @openai/codex@0.162.1 --audit=false \
    && codex --version

# OpenCode 2.x is published as @opencode/cli (the opencode-ai package is the 1.x line).
# The package is a launcher; its postinstall links the binary of a platform package
# and picks it on the build host. Done by hand here, so every build gets the same one:
# - The musl build named for this CPU. npm on this image does not pick it: it puts the
#   glibc build (about 250 MB, unusable here) under cli/node_modules, even with
#   --omit=optional, and the postinstall then downloads the musl one itself.
# - On x64 the baseline build. The default x64 build needs AVX2, and the postinstall
#   checks AVX2 on the build host, not on the host that later runs the image, where a
#   CPU without AVX2 would crash it with SIGILL. Baseline runs on every x64 CPU.
# --ignore-scripts skips the postinstall; the link and the cleanup replace it.
RUN case "$(uname -m)" in \
        x86_64) platform=linux-x64-baseline-musl ;; \
        aarch64) platform=linux-arm64-musl ;; \
        *) echo "no OpenCode build for $(uname -m)" && exit 1 ;; \
    esac \
    && npm install --global --omit=optional --ignore-scripts --audit=false \
        @opencode/cli@2.2.6 "@opencode/cli-${platform}@2.2.6" \
    && root="$(npm root -g)" \
    && ln -f "$root/@opencode/cli-${platform}/bin/opencode" "$root/@opencode/cli/bin/opencode.exe" \
    && rm -rf "$root/@opencode/cli/node_modules" \
    && opencode --version

COPY package*.json ./
COPY shared/package*.json ./shared/
COPY contract/package*.json ./contract/
COPY report/package*.json ./report/
COPY actors/runner/package*.json ./actors/runner/
COPY actors/workflow-runner/package*.json ./actors/workflow-runner/
COPY actors/judge/package*.json ./actors/judge/
COPY tools/package*.json ./tools/

RUN npm install --omit=dev --omit=optional --audit=false && rm -rf /root/.npm

COPY --from=builder /usr/src/app/contract/dist ./contract/dist
COPY --from=builder /usr/src/app/actors/workflow-runner/dist ./actors/workflow-runner/dist
# Surfaces the runner can build sessions from (surfaces/<name>.yaml).
COPY surfaces/ ./surfaces/

RUN chown -R root:root /usr/src/app && chmod -R 755 /usr/src/app \
    && mkdir -p /home/myuser/.codex && chown -R myuser:myuser /home/myuser

USER myuser
ENV CODEX_HOME=/home/myuser/.codex
ENV SURFACES_DIR=/usr/src/app/surfaces
WORKDIR /usr/src/app/actors/workflow-runner
CMD ["node", "dist/main.js"]
