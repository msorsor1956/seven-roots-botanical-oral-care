# SEVEN ROOTS | African Botanical Oral Care

Production-ready storefront and backend for the **SEVEN ROOTS** pre-launch collection.

## Live frontend

[msorsor1956.github.io/seven-roots-botanical-oral-care](https://msorsor1956.github.io/seven-roots-botanical-oral-care/)

Production: [seven-roots-botanical-oral-care-production.up.railway.app](https://seven-roots-botanical-oral-care-production.up.railway.app/)

The Railway deployment serves the frontend and API from one Node process. The GitHub Pages mirror sends its form requests to this production API.

## What is included

### Storefront

- Responsive editorial product experience
- Dependency-free Canvas 360° viewer with three pack variants
- Assembled and exploded product states
- Drag, swipe, keyboard, zoom, reset, and auto-rotation controls
- Reduced-motion and static-image fallbacks
- Accessible pre-launch signup connected to the API
- Trade, sourcing, retail, and press inquiry form

### Backend

- `GET /api/v1/health` health check for Railway
- Public pre-launch format catalog
- Validated waitlist and partner-inquiry submission endpoints
- Duplicate-email preference updates
- Honeypot spam handling and per-IP write rate limiting
- Origin allowlist, body-size limits, security headers, and request IDs
- Atomic private JSON storage with restrictive file permissions
- API-key protected admin endpoints
- Private `/admin` dashboard with summaries, interest breakdowns, lead review, and CSV export
- Automated API and static-serving tests

## Run locally

Node.js 20 or newer is required. There are no third-party runtime dependencies.

```bash
cp .env.example .env
npm start
```

Open:

- Storefront: `http://localhost:8080`
- Admin: `http://localhost:8080/admin`
- Health: `http://localhost:8080/api/v1/health`

Environment variables are not loaded automatically from `.env`; export them in your shell or configure them in Railway.

## Test

```bash
npm test
npm run check
```

## Railway production setup

The checked-in `railway.toml` tells Railpack to run `npm start`, use `/api/v1/health`, and restart failed processes. The server binds to `0.0.0.0` and Railway's injected `PORT`.

Configure these service variables:

```text
NODE_ENV=production
DATA_DIR=/data
ADMIN_API_KEY=<a long random secret>
ALLOWED_ORIGINS=https://msorsor1956.github.io,https://seven-roots-botanical-oral-care-production.up.railway.app
```

Add a Railway volume mounted at `/data`. Without a volume, submissions work but the service filesystem may be replaced during a deployment. Do not commit the generated `.data` directory or an admin key.

Then:

1. Enable GitHub auto deploys or deploy the latest commit manually.
2. Confirm the public Railway domain under **Settings → Networking**.
3. Add that exact `https://...` origin to `ALLOWED_ORIGINS`.
4. Open `/api/v1/health`, submit a test signup, and confirm it in `/admin`.

Railway configuration follows the official [Config as Code](https://docs.railway.com/config-as-code/reference), [healthcheck](https://docs.railway.com/deployments/healthchecks), and [public networking](https://docs.railway.com/networking/public-networking) guidance.

## Private API access

Admin requests require:

```text
Authorization: Bearer <ADMIN_API_KEY>
```

See [docs/API.md](docs/API.md) for endpoint details and examples.

## GitHub Pages

The Pages workflow publishes only the public storefront files. Backend source, the private admin interface, and data are excluded from the Pages artifact. Forms require the Railway-hosted version unless an API base URL is explicitly configured in the storefront metadata.

## Pre-launch notice

Products shown are in pre-launch development. Final sourcing, safety testing, regulatory review, trademarks, specifications, pricing, availability, and claims must be completed before sale.

## Rights

SEVEN ROOTS name, identity, copy, packaging concepts, images, and source code are provided for this brand project. No reuse license is granted.
