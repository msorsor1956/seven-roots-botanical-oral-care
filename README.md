# SEVEN ROOTS | African Botanical Oral Care

Production-ready storefront, Stripe payment flow, and backend for the **SEVEN ROOTS** collection.

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
- Server-priced purchase dialog with Stripe-hosted Checkout
- Branded order-confirmation page with signed-status polling, customer order number, and shipping breakdown
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
- Private `/admin` commerce dashboard with orders, inventory controls, financial reports, payment records, leads, and CSV export
- Signed Stripe webhook processing with idempotent order numbers and a separate payment ledger
- Optional per-format stock tracking with Checkout reservations, expiry release, low-stock states, and adjustment history
- Connection-ready Zoho Inventory bridge with OAuth refresh, exact SKU validation, Liberia/U.S. location stock, and a safe activation gate
- Persistent paid-order outbox with idempotent Zoho sales-order creation and retry visibility
- Gross sales, product sales, shipping, refunds, net collected, monthly performance, and product performance reports
- Automated API and static-serving tests

## Run locally

Node.js 20 or newer is required. The official Stripe Node SDK is the only third-party runtime dependency.

```bash
cp .env.example .env
npm install
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
PUBLIC_BASE_URL=https://seven-roots-botanical-oral-care-production.up.railway.app
STRIPE_API_KEY=<restricted Stripe API key>
STRIPE_WEBHOOK_SECRET=<Stripe endpoint signing secret>
STRIPE_PRICE_TRAVEL_SLEEVE=<active one-time Price ID>
STRIPE_PRICE_DAILY_RITUAL=<active one-time Price ID>
STRIPE_PRICE_FAMILY_RESERVE=<active one-time Price ID>
STRIPE_SHIPPING_COUNTRIES=US
STRIPE_SHIPPING_RATE_IDS=<optional comma-separated Shipping Rate IDs>
ZOHO_INVENTORY_ENABLED=false
ZOHO_INVENTORY_ORGANIZATION_ID=<Zoho organization ID>
ZOHO_CLIENT_ID=<Zoho server client ID>
ZOHO_CLIENT_SECRET=<Zoho server client secret>
ZOHO_REFRESH_TOKEN=<offline OAuth refresh token>
ZOHO_LIBERIA_LOCATION_ID=<Zoho Liberia source location ID>
ZOHO_US_LOCATION_ID=<Zoho U.S. fulfillment location ID>
ZOHO_ONLINE_CUSTOMER_ID=<Zoho customer ID used for web sales orders>
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_URL=https://www.zohoapis.com/inventory/v1
```

Add a Railway volume mounted at `/data`. Without a volume, submissions work but the service filesystem may be replaced during a deployment. Do not commit the generated `.data` directory or an admin key.

Use a dedicated restricted Stripe key with least-privilege access. Keep every key and webhook secret in Railway Variables; never place them in GitHub, HTML, client JavaScript, screenshots, or support messages. Run `npm run security` before publishing.

Create the production webhook endpoint at:

```text
https://seven-roots-botanical-oral-care-production.up.railway.app/api/v1/stripe/webhook
```

Subscribe it to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, and `payment_intent.payment_failed`, then store its `whsec_...` signing secret as `STRIPE_WEBHOOK_SECRET`.

Stripe Tax is not enabled by this application because no active tax registration has been confirmed. Configure registrations before enabling automatic tax collection.

Then:

1. Enable GitHub auto deploys or deploy the latest commit manually.
2. Confirm the public Railway domain under **Settings → Networking**.
3. Add that exact `https://...` origin to `ALLOWED_ORIGINS`.
4. Open `/api/v1/health`, submit a test signup, and confirm it in `/admin`.

### Turn on inventory enforcement

Inventory starts in **not tracked** mode after the automatic data migration, so a deployment never invents a physical stock count or unexpectedly disables a live product. In `/admin`:

1. Enter the actual number of sellable packs on hand for each format.
2. Set the low-stock threshold.
3. Save the count with an adjustment note.

Once a format has a stock count, new Checkout Sessions reserve the requested packs. A signed successful-payment event converts the reservation into sold stock; an expired or failed Checkout releases it. Refunds are recorded financially but do not automatically restock a physical item because a refund does not prove that sellable goods were returned. Update the physical count after inspecting a return.

### Connect Zoho Inventory when the account is ready

The deployed code can remain disconnected safely. It never accepts Zoho credentials through the browser or an API request; secrets belong only in Railway Variables.

1. In Zoho Inventory, create the three items with the exact SKUs `SR-T01`, `SR-R05`, and `SR-F12`.
2. Create a Liberia source location and a U.S. fulfillment location, then copy both location IDs.
3. Create a dedicated `SEVEN ROOTS Online Store` customer and copy its customer ID. Paid web orders are filed against this customer while the Stripe order number remains the unique Zoho sales-order reference.
4. Register a Zoho server-based OAuth client and issue an offline refresh token with only these scopes: `ZohoInventory.items.READ`, `ZohoInventory.settings.READ`, `ZohoInventory.contacts.READ`, `ZohoInventory.salesorders.CREATE`, `ZohoInventory.salesorders.READ`, and `ZohoInventory.salesorders.UPDATE`.
5. Add the variables above in Railway, leaving `ZOHO_INVENTORY_ENABLED=false`.
6. Open `/admin`, run **Test connection**, and verify both locations plus all three SKU mappings.
7. Run **Sync inventory** in readiness mode. This displays both warehouse counts without changing checkout.
8. Set `ZOHO_INVENTORY_ENABLED=true` in Railway, redeploy, and run **Sync inventory** again. Verified U.S. sellable counts then become the checkout authority, while Liberia quantities remain visible for replenishment planning.

Every signed paid Stripe order enters a durable outbox. When Zoho is enabled, the backend creates or finds the matching Zoho sales order by the SEVEN ROOTS order number, confirms it, and records the Zoho sales-order ID. Failed exports remain visible and can be retried from the admin dashboard. This follows Zoho's official [OAuth](https://www.zoho.com/inventory/api/v1/oauth/), [Items](https://www.zoho.com/inventory/api/v1/items/), [Locations](https://www.zoho.com/inventory/api/v1/locations/), and [Sales Orders](https://www.zoho.com/inventory/api/v1/salesorders/) API contracts.

Railway configuration follows the official [Config as Code](https://docs.railway.com/config-as-code/reference), [healthcheck](https://docs.railway.com/deployments/healthchecks), and [public networking](https://docs.railway.com/networking/public-networking) guidance.

## Private API access

Admin requests require:

```text
Authorization: Bearer <ADMIN_API_KEY>
```

See [docs/API.md](docs/API.md) for endpoint details and examples.

## GitHub Pages

The Pages workflow publishes only the public storefront files. Backend source, the private admin interface, and data are excluded from the Pages artifact. Forms require the Railway-hosted version unless an API base URL is explicitly configured in the storefront metadata.

## Commerce notice

Checkout stays disabled until every required Stripe variable, approved one-time Price ID, delivery destination, and signed webhook secret is configured. Product compliance, fulfillment, shipping, returns, and applicable tax obligations remain the merchant’s responsibility.

## Rights

SEVEN ROOTS name, identity, copy, packaging concepts, images, and source code are provided for this brand project. No reuse license is granted.
