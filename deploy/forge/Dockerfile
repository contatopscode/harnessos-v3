# VOLUND FORGE — static site served by Bun.
#
# Two-stage build. The Vite build is done at image build time so the
# `VITE_FORGE_API_BASE_URL` is baked into the JS — no runtime config needed.
#
# Build (from repo root):
#   docker build -t forge \
#     --build-arg VITE_FORGE_API_BASE_URL=https://harness-os.pscode.ia.br \
#     -f deploy/forge/Dockerfile .
#
# Run:
#   docker run -p 5180:5180 forge
#
# The image is small: oven/bun:slim + the dist/ + a 80-line server.ts. Total
# ~80 MB. The Vite bundle alone is ~770 KB ungzipped (~225 KB gzipped).
FROM oven/bun:1 AS build
WORKDIR /repo

# Copy JUST what bun needs to install + build the FORGE app. Avoids copying
# the entire monorepo (which would inflate the build context dramatically).
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps/forge ./apps/forge
COPY scripts ./scripts 2>/dev/null || true

ARG VITE_FORGE_API_BASE_URL
ENV VITE_FORGE_API_BASE_URL=${VITE_FORGE_API_BASE_URL}

RUN cd apps/forge && bun install --frozen-lockfile && bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /repo/apps/forge/dist /app/dist
COPY deploy/forge/server.ts /app/server.ts

ENV PORT=5180
ENV HOSTNAME=0.0.0.0
EXPOSE 5180

# Bun's entrypoint runs server.ts directly. We pre-check the dist exists so
# a stale image fails loudly instead of serving a 404 forever.
CMD ["sh", "-c", "test -d /app/dist && exec bun run /app/server.ts"]
