# Pastebin Lite

A simple Pastebin-like web application built with Node.js, Express, and Redis (Upstash).  

## Features
- Create text pastes with optional TTL (time-based expiry) and max views
- Shareable URLs for each paste
- Safe HTML rendering (no script execution)
- Redis-backed persistence
- Supports deterministic expiry testing via `TEST_MODE`

## Tech Stack
- Node.js
- Express
- Redis (Upstash)
- Deployed on Vercel



## Running Locally
1. Clone the repository
```bash
https://github.com/RajuNadapana/pastebin-lite-aganitha
cd pastebin-lite-aganitha
````

2. Install dependencies

```bash
npm install
```

3. Create a `.env` file with:

```
REDIS_URL=your_upstash_redis_url
```

4. Start the server

```bash
npm start
```

5. Open in browser: `http://localhost:3000`

## Persistence

Uses **Upstash Redis** to store pastes across deployments.

## Deployment

Deployed on **Vercel**: [https://pastebin-lite-aganitha.vercel.app](https://pastebin-lite-aganitha.vercel.app)
