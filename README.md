# Tejas Computer Institute

Node.js + Express website with static frontend and JSON data persistence.

## Run Locally

1. Install dependencies:
```bash
npm install
```
2. Configure environment:
```bash
cp .env.example .env
```
3. Start:
```bash
npm start
```
4. Health check:
```bash
curl http://localhost:3000/api/health
```

## Deploy on Render

This repo includes `render.yaml` for one-click deploy.

1. Push code to GitHub.
2. In Render, create a new Blueprint deployment from this repo.
3. Set secret env vars in Render dashboard:
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `GOOGLE_CLIENT_ID`
   - `GEMINI_API_KEY`
   - `OPENAI_API_KEY` (optional fallback)
4. Render disk is configured in `render.yaml` and mounted to `DATA_DIR`.

## Deploy with Docker

Build:
```bash
docker build -t tejas-app .
```

Run:
```bash
docker run -p 3000:3000 \
  -e PORT=3000 \
  -e DATA_DIR=/app/data \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=admin123 \
  -v tejas_data:/app/data \
  tejas-app
```

## Important Notes

- Persist `/data` (`DATA_DIR`) in production, otherwise user/inquiry data resets on restart.
- Never commit real `.env` secrets.
