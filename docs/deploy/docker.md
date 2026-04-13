---
title: Docker
summary: Docker Compose quickstart
---

Run Combyne in Docker without installing Node or pnpm locally.

## Compose Quickstart (Recommended)

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

Defaults:

- Host port: `3100`
- Data directory: `./data/docker-combyne`

Override with environment variables:

```sh
COMBYNE_PORT=3200 COMBYNE_DATA_DIR=./data/pc \
  docker compose -f docker-compose.quickstart.yml up --build
```

## Manual Docker Build

```sh
docker build -t combyne-local .
docker run --name combyne \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e COMBYNE_HOME=/combyne \
  -v "$(pwd)/data/docker-combyne:/combyne" \
  combyne-local
```

## Data Persistence

All data is persisted under the bind mount (`./data/docker-combyne`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Claude and Codex Adapters in Docker

The Docker image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name combyne \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e COMBYNE_HOME=/combyne \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$(pwd)/data/docker-combyne:/combyne" \
  combyne-local
```

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
