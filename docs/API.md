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

Returns a short-lived Stripe-hosted Checkout URL. Product and Price IDs are selected exclusively on the server. Quantity must be a whole number from 1 to 10.

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

Webhook event IDs are stored for idempotency.

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

The browser dashboard at `/admin` uses these endpoints. The key is held in `sessionStorage`, not persistent browser storage.

## Limits and privacy

- JSON request bodies are limited to 32 KB.
- Public write endpoints are limited to 20 submissions per IP per 15 minutes.
- Honeypot submissions are accepted without storing their content.
- Admin data is never returned by public endpoints.
- Stripe secret and restricted keys never reach browser code or API responses.
- Checkout amounts come from configured Stripe Price IDs, not request data.
- Automatic tax is intentionally off until applicable Stripe Tax registrations are confirmed.
- The storage file is created with owner-only permissions and should live on a Railway volume mounted at `/data`.
