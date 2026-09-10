# RAG Class Recordings

A retrieval-augmented chat interface for asking questions about class
recordings and jumping back to the supporting timestamped transcript chunks.

## Prerequisites

- [Bun](https://bun.com) 1.3 or newer
- Docker Desktop, for the local PostgreSQL + pgvector database
- A configured `.env` file with `DATABASE_URL`, `OPENAI_API_KEY`, and
  `PUBLIC_COHORT_ID`

Install the workspace dependencies once:

```bash
bun install
```

If `.env` does not exist yet, create it from the documented example and fill in
the required values:

```bash
cp .env.example .env
```

## Start the project

The database in this workspace is already populated and its recordings are
already chunked. Normal startup does **not** require migrations, seeding,
ingestion, reindexing, or chunk generation.

1. Start the existing PostgreSQL database:

   ```bash
   docker compose up -d postgres
   ```

2. Start the API in a separate terminal:

   ```bash
   bun run dev:api
   ```

3. Start the frontend in another terminal:

   ```bash
   bun run dev:web
   ```

4. Open [http://localhost:5173](http://localhost:5173).

The API runs at `http://localhost:3000` by default. The frontend and API ports
can be changed with `WEB_PORT` and `PORT` in `.env`; if they change, keep
`PUBLIC_API_BASE_URL` and `CORS_ALLOWED_ORIGINS` in sync.

## Verify the services

Check API liveness:

```bash
curl http://localhost:3000/health
```

Check database and pgvector readiness:

```bash
curl http://localhost:3000/ready
```

A ready installation returns `{"status":"ready","database":true,"pgvector":true}`.

## Useful commands

```bash
bun test             # Run the test suite
bun run inspect:chunks  # Inspect existing chunks without modifying them
```
