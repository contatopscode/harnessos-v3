# syntax=docker/dockerfile:1.6
# =============================================================================
# Archon / HarnessOS - Remote Agentic Coding Platform
# Multi-stage build optimized for BuildKit cache mounts.
#
# Why this shape:
#   - `--mount=type=cache` (Bun / apt / npm) keeps the package cache warm
#     across deploys. A deploy that touches one .ts file re-uses the entire
#     `bun install` result, slashing the 4-5 minute "fresh install" penalty
#     that was killing Easypanel deploys at the 9-minute build timeout.
#   - Three explicit stages: `base-deps` (cached, prod-only deps) → `builder`
#     (adds dev deps + web build) → `production` (slim runtime, no test src).
#   - Apt + npm + Bun caches are declared PER RUN so each one re-uses its
#     own cache slot (different mount targets, distinct `--mount` ids).
#   - `apt-get` only runs once per `RUN` invocation; each stage that needs
#     a system package uses the same cache mount id, so the second call
#     within a multi-RUN stage also hits the cache.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Base deps (prod-only) — cached across deploys when package.json
# is unchanged. Layer is small (just node_modules) and pulls forward to the
# production stage via `--from=base-deps`.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.11-slim AS base-deps

WORKDIR /app

# Copy lockfile + every workspace package.json (Bun's workspace resolver
# requires them present even when installing prod-only deps).
COPY package.json bun.lock ./
COPY packages/*/package.json ./packages/
COPY apps/*/package.json ./apps/

# Bun install cache survives across `docker build` invocations when the
# build context runs on a BuildKit-enabled daemon (Easypanel uses
# `docker buildx build --network host`, so the cache mount works).
# `--ignore-scripts` skips husky's `prepare` hook (we're inside a container,
# not a git repo, and the postinstall side-effects of optional deps aren't
# required at runtime).
RUN --mount=type=cache,target=/root/.bun/install/cache,id=bun-install \
    bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted

# ---------------------------------------------------------------------------
# Stage 2: Builder — adds devDependencies + runs the Vite web build.
# Inherits the hoisted node_modules from base-deps so Bun's workspace
# links resolve. Only the missing devDeps get installed (incremental).
# ---------------------------------------------------------------------------
FROM base-deps AS builder

# Install devDependencies needed for the web build (Vite, tsc, etc.).
# Reuses the same cache mount id as base-deps so Bun's package cache is
# shared between the two stages.
RUN --mount=type=cache,target=/root/.bun/install/cache,id=bun-install \
    bun install --frozen-lockfile --linker=hoisted

# Copy the rest of the source. .dockerignore keeps this fast:
#   - node_modules/** already excluded
#   - .git/** already excluded
#   - test files excluded
#   - .claude/skills/archon + manage-run kept (Path B)
COPY . .

# Build the web frontend. Output goes to packages/web/dist/.
RUN bun run build:web && \
    test -f packages/web/dist/index.html || \
    (echo "ERROR: Web build produced no index.html" >&2 && exit 1)

# ---------------------------------------------------------------------------
# Stage 3: Production runtime — slim image, no source, no devDeps.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.11-slim AS production

# OCI Labels for GHCR
LABEL org.opencontainers.image.source="https://github.com/coleam00/Archon"
LABEL org.opencontainers.image.description="Control AI coding assistants remotely from Telegram, Slack, Discord, and GitHub"
LABEL org.opencontainers.image.licenses="MIT"

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Combined apt install: every system dep lands in one cached layer.
# The same cache mount id is used across runs so the second `apt-get`
# (GitHub CLI + agent-browser deps) re-uses the package cache.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked,id=apt-cache \
    --mount=type=cache,target=/var/lib/apt,sharing=locked,id=apt-lib \
    --mount=type=cache,target=/root/.npm,id=npm-cache \
    set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl \
        git \
        bash \
        ca-certificates \
        gnupg \
        gosu \
        postgresql-client \
        # ripgrep + jq: expected by Claude Code / Codex agents (rg is their default
        # code-search tool; jq powers JSON handling in bash workflow nodes) — see #1836
        ripgrep \
        jq \
        # Chromium for agent-browser E2E testing (drives browser via CDP)
        chromium \
        # Node.js + npm are needed only for the agent-browser postinstall step
        # (it downloads a native Rust binary). Removed after install.
        nodejs \
        npm; \
    # GitHub CLI: pinned repo + keyring, then apt install.
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    # agent-browser: npm install grabs the Node wrapper; we copy the native
    # binary out, then drop nodejs/npm entirely (~60MB saved).
    npm install -g agent-browser@0.22.1; \
    NATIVE_BIN=$(find /usr/local/lib/node_modules/agent-browser -name 'agent-browser-*' -type f -executable 2>/dev/null | head -1); \
    if [ -n "$NATIVE_BIN" ]; then \
         cp "$NATIVE_BIN" /usr/local/bin/agent-browser-native; \
         chmod +x /usr/local/bin/agent-browser-native; \
         ln -sf /usr/local/bin/agent-browser-native /usr/local/bin/agent-browser; \
    else \
         echo "ERROR: agent-browser native binary not found after npm install" >&2; exit 1; \
    fi; \
    npm cache clean --force; \
    rm -rf /usr/local/lib/node_modules/agent-browser; \
    apt-get purge -y nodejs npm; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# Point agent-browser to system Chromium (avoids ~400MB Chrome-for-Testing download)
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Create non-root user for running Claude Code
# Claude Code refuses to run with --dangerously-skip-permissions as root for security
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && chown -R appuser:appuser /app

# Create Archon directories
RUN mkdir -p /.archon/workspaces /.archon/worktrees \
    && chown -R appuser:appuser /.archon

# Production deps: pull the hoisted node_modules from base-deps (already
# `bun install --production`'d there — this is the BIG win: no second
# download, no apt interaction, just a layer copy).
COPY --from=base-deps /app/node_modules ./node_modules

# Application source: each package directory is its own COPY so changes
# in one package don't bust the cache for the others. `bun` runs TS
# directly, no compile step needed.
COPY packages/adapters/ ./packages/adapters/
COPY packages/cli/ ./packages/cli/
COPY packages/core/ ./packages/core/
COPY packages/git/ ./packages/git/
COPY packages/isolation/ ./packages/isolation/
COPY packages/paths/ ./packages/paths/
COPY packages/providers/ ./packages/providers/
COPY packages/server/ ./packages/server/
COPY packages/workflows/ ./packages/workflows/

# Pre-built web UI from builder stage
COPY --from=builder /app/packages/web/dist/ ./packages/web/dist/

# Config, migrations, and bundled defaults
COPY package.json bun.lock ./
COPY .archon/ ./.archon/
COPY migrations/ ./migrations/
# Bundled skill files — packages/core/src/skills/bundled-skill.ts dynamically
# imports .claude/skills/{archon,manage-run}/** with { type: 'text' }. The
# dynamic import is gated by `installArchonSkills` so it never runs in the
# web build stage, but it still needs the files on disk in the production
# image in case `archon skill install` (or the Web UI's POST /api/codebases
# /{id}/skills endpoint) is invoked at runtime.
COPY .claude/ ./.claude/
COPY tsconfig*.json ./

# Fix permissions for appuser (single chown, not per-COPY)
RUN chown -R appuser:appuser /app

# Create .codex directory for Codex authentication
RUN mkdir -p /home/appuser/.codex && chown appuser:appuser /home/appuser/.codex

# Configure git to trust Archon directories (as appuser)
RUN gosu appuser git config --global --add safe.directory '/.archon/workspaces' && \
    gosu appuser git config --global --add safe.directory '/.archon/workspaces/*' && \
    gosu appuser git config --global --add safe.directory '/.archon/worktrees' && \
    gosu appuser git config --global --add safe.directory '/.archon/worktrees/*'

# Copy entrypoint script (fixes volume permissions, drops to appuser)
# sed strips Windows CRLF in case .gitattributes eol=lf was bypassed
COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Default port (matches .env.example PORT=3000)
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
