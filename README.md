# SEVEN ROOTS | African Botanical Oral Care

Production-ready storefront, Stripe payment flow, and backend for the **SEVEN ROOTS** collection.

## Live frontend

[msorsor1956.github.io/seven-roots-botanical-oral-care](https://msorsor1956.github.io/seven-roots-botanical-oral-care/)

Production: [sevenroots.info](https://sevenroots.info/)

The Railway deployment serves the frontend and API from one Node process. The GitHub Pages mirror sends its form requests to this production API.

## What is included

### Storefront

- Responsive editorial product experience
- Dependency-free Canvas 360° viewer with three pack variants
- Assembled and exploded product states
- Branded three-format exploded packaging family with proposed metric and imperial production dimensions
- Downloadable four-page packaging production brief with material, construction, and validation guidance
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
- Private `/admin` commerce dashboard with orders, inventory controls, financial reports, payment records, leads, CSV export, and cross-location task allocation
- Individual employee accounts with automatically emailed, expiring one-time invitations, delivery records, password hashing, secure sessions, CSRF protection, lockout controls, and access deactivation
- Role- and location-scoped `/staff` operations portal for Liberia warehouse, U.S. fulfillment, finance, support, audit, and ownership teams
- Assigned work queues, two-person physical count approval, Liberia-to-U.S. transfer custody, paid-order fulfillment states, and append-only operational audit history
- SOW-driven operations with private document, photo, and video uploads; required-evidence gates; manager review; and photo/signature-backed completion records
- Authenticated employee/admin contact directory, WhatsApp click-to-chat, and provider-ready Meta WhatsApp Cloud API task notifications
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
- Staff operations: `http://localhost:8080/staff`
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
ALLOWED_ORIGINS=https://sevenroots.info,https://www.sevenroots.info,https://msorsor1956.github.io,https://seven-roots-botanical-oral-care-production.up.railway.app
PUBLIC_BASE_URL=https://sevenroots.info
RESEND_API_KEY=<Resend server API key>
EMAIL_FROM=SEVEN ROOTS <staff@your-verified-domain.example>
EMAIL_REPLY_TO=<optional monitored reply address>
MAX_TASK_FILE_MB=50
ADMIN_CONTACT_NAME=SEVEN ROOTS Owner Admin
ADMIN_CONTACT_EMAIL=hello@sevenroots.info
ADMIN_CONTACT_PHONE=<admin phone>
ADMIN_WHATSAPP_NUMBER=<international number beginning with +>
WHATSAPP_ACCESS_TOKEN=<Meta system-user access token>
WHATSAPP_PHONE_NUMBER_ID=<WhatsApp business phone number ID>
WHATSAPP_GRAPH_VERSION=<current supported Graph API version, such as v23.0>
WHATSAPP_TASK_TEMPLATE=<approved three-variable template name>
WHATSAPP_TEMPLATE_LANGUAGE=en_US
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
ZOHO_TOKEN_ENCRYPTION_KEY=<base64-encoded 32-byte key>
ZOHO_REFRESH_TOKEN=<optional legacy offline OAuth refresh token>
ZOHO_LIBERIA_LOCATION_ID=<Zoho Liberia source location ID>
ZOHO_US_LOCATION_ID=<Zoho U.S. fulfillment location ID>
ZOHO_ONLINE_CUSTOMER_ID=<optional existing Zoho customer ID used for web sales orders>
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

The deployed code can remain disconnected safely. The OAuth client secret stays in Railway, and the reusable refresh token is encrypted with AES-256-GCM on the private Railway volume. It is never returned by an API or written to GitHub.

1. In Zoho Inventory, enable Locations and create a Liberia source location plus a U.S. fulfillment location.
2. Register a Zoho server-based OAuth client with homepage `https://sevenroots.info` and redirect URI `https://sevenroots.info/api/v1/zoho/callback`.
3. Add the organization, client, location, data-center, and encryption-key variables above in Railway, leaving `ZOHO_INVENTORY_ENABLED=false`. `ZOHO_REFRESH_TOKEN` and `ZOHO_ONLINE_CUSTOMER_ID` can remain unset when using the secure admin connection flow.
4. Open `/admin` and select **Connect Zoho securely**. The app requests only item read/create, settings read, contact read/create, sales-order read/create/update, and transfer-order read/create/update permissions.
5. Select **Prepare products & customer**. The app reuses matching records and creates only missing SKUs `SR-T01`, `SR-R05`, and `SR-F12` with zero opening stock, plus the dedicated `SEVEN ROOTS Online Store` customer.
6. Run **Test connection**, then **Sync inventory** in readiness mode. This displays both warehouse counts without changing checkout.
7. Enter verified physical quantities in Zoho. Do not activate inventory authority while opening stock is still zero or unverified.
8. Set `ZOHO_INVENTORY_ENABLED=true` in Railway only after every SKU has verified U.S. sellable stock, redeploy, and run **Sync inventory** again. U.S. counts then control checkout while Liberia counts remain visible for replenishment planning.

Every signed paid Stripe order enters a durable outbox. When Zoho is enabled, the backend creates or finds the matching Zoho sales order by the SEVEN ROOTS order number, confirms it, and records the Zoho sales-order ID. Approved Liberia-to-U.S. replenishment records similarly create idempotent Zoho transfer orders and follow their in-transit and received states. Failed exports remain visible and can be retried from the admin dashboard. This follows Zoho's official [OAuth](https://www.zoho.com/inventory/api/v1/oauth/), [Items](https://www.zoho.com/inventory/api/v1/items/), [Locations](https://www.zoho.com/inventory/api/v1/locations/), [Sales Orders](https://www.zoho.com/inventory/api/v1/salesorders/), and [Transfer Orders](https://www.zoho.com/inventory/api/v1/transferorders/) API contracts.

### Add employees and staff

The `ADMIN_API_KEY` remains the owner recovery and bootstrap credential. Use it to open `/admin`, then use **Staff operations** to create each person's individual account:

1. Enter the employee's name and work email.
2. Choose the least-privilege job role and permitted location. Location rules are enforced by the backend, not only hidden in the browser.
3. Select **Invite and email**. The backend sends the one-time activation link to the employee's address and records its delivery status. The owner dashboard also shows a recovery copy; only the token hash is stored, and a new invitation invalidates the previous one.
4. The employee opens the link, creates a password of at least 12 characters, and then works from `/staff`.
5. The employee completes **My profile** with phone, international WhatsApp number, and a profile photo. Managers and owners also upload a signature image before approving work.
6. Deactivate an employee from `/admin` as soon as access should end. Existing sessions are revoked.

Suggested operating assignment: Liberia warehouse staff submit receiving, quality, packing, and count work; a Liberia manager approves counts and dispatches replenishment; U.S. fulfillment receives transfers and advances paid orders through picking, packing, shipment, and delivery; finance and audit roles remain read-only for operational changes. Physical inventory counts require a different approving employee.

Invitation delivery uses Resend's server-side email API. First add and verify a sender domain in Resend, then add `RESEND_API_KEY` and `EMAIL_FROM` to the Railway service variables and redeploy. A dedicated sending subdomain is recommended so transactional staff mail is isolated from other mail. If delivery is unavailable, the employee account and one-time link remain valid, the failure is shown in `/admin`, and **Email new invite** creates and sends a replacement link. See Resend's official [send-email API](https://resend.com/docs/api-reference/emails/send-email) and [domain verification](https://resend.com/docs/dashboard/domains/introduction) guides.

### Run documented work and approvals

Admins create and allocate operations from **Admin → Operations task queue**. Liberia and U.S. managers can also create and assign tasks from **Staff portal → My work** within their permitted locations. Every operation requires a Scope of Work and an explicit evidence checklist. The creator can attach SOW/reference documents, photos, and video. The assigned employee claims or starts the work, uploads completion evidence, and submits a completion note. The task becomes **pending approval** and cannot be marked completed directly. A different authorized manager either requests changes or approves it. Approval records the manager's name, profile photo, signature image, note, and timestamp; the employee and admin dashboards then show the completed approval record.

Work files are stored privately under `DATA_DIR/work-files` on the Railway volume. They are never served as public static assets: every download rechecks the staff session, task visibility, role, and location. Supported formats include PDF, Word, Excel, text/CSV, JPEG/PNG/WebP/HEIC, MP4/MOV/WebM. `MAX_TASK_FILE_MB` controls the per-file limit from 1–100 MB.

WhatsApp always supports authenticated click-to-chat from employee and task cards after a WhatsApp number is added. For automatic assignment, submission, approval, and changes-requested notifications, configure the Meta WhatsApp Cloud API variables above and create an approved template containing exactly three body variables in this order: employee name, task title, task status. Provider credentials remain server-side. See Meta's official [Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/) and [message templates guide](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/).

Railway configuration follows the official [Config as Code](https://docs.railway.com/config-as-code/reference), [healthcheck](https://docs.railway.com/deployments/healthchecks), and [public networking](https://docs.railway.com/networking/public-networking) guidance.

## Private API access

Admin requests require:

```text
Authorization: Bearer <ADMIN_API_KEY>
```

See [docs/API.md](docs/API.md) for endpoint details and examples.

## Packaging production brief

The storefront includes proposed package descriptions and dimensions for the one-stick Travel Sleeve, five-stick Daily Ritual, and twelve-stick Family Reserve. The supplier-facing brief is available at [assets/SEVEN_ROOTS_Packaging_Production_Brief.pdf](assets/SEVEN_ROOTS_Packaging_Production_Brief.pdf), with the editable source specification in [docs/PACKAGING-SPECIFICATIONS.md](docs/PACKAGING-SPECIFICATIONS.md).

These measurements are a design and quoting basis, not final dielines. Confirm them against conditioned production samples and converter engineering before tooling or mass production.

## GitHub Pages

The Pages workflow publishes only the public storefront files. Backend source, the private admin interface, and data are excluded from the Pages artifact. Forms require the Railway-hosted version unless an API base URL is explicitly configured in the storefront metadata.

## Commerce notice

Checkout stays disabled until every required Stripe variable, approved one-time Price ID, delivery destination, and signed webhook secret is configured. Product compliance, fulfillment, shipping, returns, and applicable tax obligations remain the merchant’s responsibility.

## Rights

SEVEN ROOTS name, identity, copy, packaging concepts, images, and source code are provided for this brand project. No reuse license is granted.
