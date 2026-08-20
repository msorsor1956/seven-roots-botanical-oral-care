# SEVEN ROOTS API

Base path: `/api/v1`

Every response is JSON except static storefront and admin files. Error responses use:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Check the highlighted fields.",
    "details": {
      "email": "Enter a valid email address."
    },
    "requestId": "..."
  }
}
```

## Public endpoints

### Health

```http
GET /api/v1/health
```

Returns `200` when the web process and private file store have initialized.

### Product formats

```http
GET /api/v1/formats
GET /api/v1/formats/daily-ritual
```

When Stripe is fully configured, each format includes server-retrieved `unitAmount` and `currency`. Otherwise `pricing` is `null`; the browser never supplies or overrides an amount.

### Create a secure Checkout Session

```http
POST /api/v1/checkout/sessions
Content-Type: application/json

{
  "formatSlug": "daily-ritual",
  "quantity": 2
}
```

Returns a short-lived Stripe-hosted Checkout URL. Product and Price IDs are selected exclusively on the server. Quantity must be a whole number from 1 to 10. When a format has a configured stock count, the requested quantity is reserved before Stripe Checkout is created. Insufficient stock returns `409 insufficient_inventory`.

### Look up a public order confirmation

```http
GET /api/v1/orders/lookup?session_id=cs_...
```

Returns only non-sensitive confirmation fields. Customer contact, delivery address, PaymentIntent ID, and the full Stripe Session ID are never included in this response.

### Stripe webhook

```http
POST /api/v1/stripe/webhook
Stripe-Signature: ...
```

The handler verifies the signature against the unmodified raw body before processing. Supported order events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `payment_intent.payment_failed`

Webhook event IDs are stored for idempotency. A completed payment creates a customer-facing `SR-...` order number, updates the private payment ledger, and decrements tracked inventory exactly once. Failed and expired Checkout events release active reservations.

### Join the pre-launch list

```http
POST /api/v1/waitlist
Content-Type: application/json

{
  "name": "Amina Johnson",
  "email": "amina@example.com",
  "preferredFormat": "daily-ritual",
  "country": "United States",
  "source": "website-dialog",
  "consent": true,
  "website": ""
}
```

`preferredFormat` accepts a product slug or product name. A repeat email updates the existing preference instead of creating a duplicate.

### Send a partner inquiry

```http
POST /api/v1/inquiries
Content-Type: application/json

{
  "name": "Retail Buyer",
  "email": "buyer@example.com",
  "phone": "+1 317 555 0100",
  "organization": "Example Market",
  "inquiryType": "wholesale",
  "message": "I would like to discuss carrying the Daily Ritual format.",
  "consent": true,
  "website": ""
}
```

Allowed inquiry types: `wholesale`, `retail`, `press`, `sourcing`, and `general`.

## Private admin endpoints

Set `ADMIN_API_KEY` and send it as a bearer token.

```http
Authorization: Bearer YOUR_ADMIN_API_KEY
```

Endpoints:

- `GET /api/v1/admin/summary`
- `GET /api/v1/admin/waitlist?limit=500`
- `GET /api/v1/admin/inquiries?limit=500`
- `GET /api/v1/admin/orders?limit=500`
- `GET /api/v1/admin/payments?limit=500`
- `GET /api/v1/admin/inventory`
- `GET /api/v1/admin/inventory-adjustments?limit=500`
- `GET /api/v1/admin/financial-report`
- `GET /api/v1/admin/zoho/status`
- `GET /api/v1/admin/zoho/orders?limit=500`
- `POST /api/v1/admin/zoho/test`
- `POST /api/v1/admin/zoho/sync`
- `POST /api/v1/admin/zoho/orders/sync`

Update a physical inventory count:

```http
PATCH /api/v1/admin/inventory/daily-ritual
Authorization: Bearer YOUR_ADMIN_API_KEY
Content-Type: application/json

{
  "stockOnHand": 48,
  "reorderLevel": 10,
  "reason": "Opening physical count"
}
```

Set `stockOnHand` to `null` to stop enforcing inventory for that format. The public catalog reports only `available` or `sold_out`; exact counts, reservations, adjustment notes, customer data, and Stripe references remain private.

The financial report separates gross sales, product sales, shipping collected, tax collected, refunds, and net collected by currency. `netCollected` is before Stripe fees, fulfillment costs, and operating expenses; it is not an accounting profit figure.

### Zoho Inventory bridge

`GET /api/v1/admin/zoho/status` reports configuration readiness, masked organization information, the Zoho data center, Liberia and U.S. locations, SKU mappings, last synchronization, and paid-order outbox counts. It never returns an OAuth credential.

`POST /api/v1/admin/zoho/test` validates OAuth, configured location IDs, and exact SKU mappings without changing checkout inventory. `POST /api/v1/admin/zoho/sync` pulls the latest location quantities. When `ZOHO_INVENTORY_ENABLED=false`, the pull is a readiness preview; when enabled and all mappings pass, the U.S. location's sellable quantity becomes authoritative for checkout.

Signed paid Stripe events enter a persistent Zoho outbox. `POST /api/v1/admin/zoho/orders/sync` retries pending or failed exports. `GET /api/v1/admin/zoho/orders` returns the private outbox status and Zoho sales-order IDs. Zoho writes are idempotent by the customer-facing `SR-...` order number.

The browser dashboard at `/admin` uses these endpoints. The key is held in `sessionStorage`, not persistent browser storage.

### Employee administration

The owner bootstrap key manages individual staff accounts. Invitation tokens are returned only when created and should be copied immediately.

- `GET /api/v1/admin/staff/roles`
- `GET /api/v1/admin/staff`
- `POST /api/v1/admin/staff`
- `PATCH /api/v1/admin/staff/:userId`
- `POST /api/v1/admin/staff/:userId/invitations`
- `GET /api/v1/admin/audit?limit=200`

Create and invite an employee:

```http
POST /api/v1/admin/staff
Authorization: Bearer YOUR_ADMIN_API_KEY
Content-Type: application/json

{
  "name": "Martha Kromah",
  "email": "martha@example.com",
  "role": "liberia_staff",
  "country": "Liberia",
  "locations": ["liberia"]
}
```

Available roles are `owner`, `liberia_manager`, `liberia_staff`, `us_manager`, `us_fulfillment`, `finance`, `customer_support`, and `auditor`. Each role has a fixed backend permission set and permitted location assignment. Deactivating a user revokes every active session.

## Staff authentication and operations

Staff authentication uses an `HttpOnly`, `SameSite=Lax` session cookie. The invitation acceptance and login response also returns a CSRF token; send it as `X-CSRF-Token` on every staff mutation. Passwords must contain 12 to 128 characters. Invitation links expire, are single-use, and are stored only as hashes.

Authentication:

- `POST /api/v1/staff/auth/accept-invite`
- `POST /api/v1/staff/auth/login`
- `GET /api/v1/staff/auth/session`
- `POST /api/v1/staff/auth/logout`

Operations:

- `GET /api/v1/staff/workspace`
- `POST /api/v1/staff/tasks`
- `PATCH /api/v1/staff/tasks/:taskId`
- `POST /api/v1/staff/inventory/counts`
- `POST /api/v1/staff/inventory/counts/:countId/review`
- `POST /api/v1/staff/transfers`
- `POST /api/v1/staff/transfers/:transferId/approve`
- `POST /api/v1/staff/transfers/:transferId/dispatch`
- `POST /api/v1/staff/transfers/:transferId/receive`
- `PATCH /api/v1/staff/orders/:orderId/fulfillment`

Example physical count:

```http
POST /api/v1/staff/inventory/counts
Cookie: sr_staff_session=...
X-CSRF-Token: ...
Content-Type: application/json

{
  "location": "liberia",
  "formatSlug": "daily-ritual",
  "countedStock": 48,
  "reason": "Friday close count"
}
```

A different employee with `inventory.approve` must approve or reject a submitted count. When Zoho is the inventory authority, an approved count remains `approved_pending_zoho` until the physical adjustment is recorded in Zoho and synchronized; the staff portal never silently overwrites an authoritative Zoho count.

Transfers in this release move from Liberia to U.S. fulfillment through `draft`, `approved`, `in_transit`, and `received`. Dispatch requires either a freight reference or both carrier and tracking number. When Zoho is active, owner approval creates or finds the matching Zoho Transfer Order and later actions update that transfer's custody state.

## Limits and privacy

- JSON request bodies are limited to 32 KB.
- Public write endpoints are limited to 20 submissions per IP per 15 minutes.
- Honeypot submissions are accepted without storing their content.
- Admin data is never returned by public endpoints.
- Staff data is filtered by both role permission and assigned warehouse location on the server.
- Staff write requests require a valid session cookie and matching CSRF token; five invalid password attempts temporarily lock the account.
- Stripe secret and restricted keys never reach browser code or API responses.
- Zoho OAuth credentials never reach browser code, API responses, logs, or the data store.
- Checkout amounts come from configured Stripe Price IDs, not request data.
- Automatic tax is intentionally off until applicable Stripe Tax registrations are confirmed.
- The storage file is created with owner-only permissions and should live on a Railway volume mounted at `/data`.
