# courtside-back (Claude Code)

- **Full endpoint reference: `courtside-front/docs/API.md`** — every /api route, auth level, notes.
  Update it whenever a route is added/changed. Per-domain detail: `src/routes/doc/API_*.md`.
- Stack: Node.js, Express, MySQL (mysql2), JWT, Stripe, nodemailer, node-cron, joi. CommonJS only.
- Entry: src/index.js. API base: /api. Auth: /api/auth. Stripe webhook mounted BEFORE express.json().
- Structure: src/routes, src/controllers, src/services, src/middleware, src/utils, src/migrations.
- DB: mysql2 pool injected into routers. **One access style, no exceptions**: `src/utils/dbHelpers.js`
  (`queryPromise`, `queryOne`, `insert`, `poolOf`, `getClubIdByName`) sits on mysql2's promise pool.
  `db.query(sql, params, cb)` no longer exists anywhere in src/ — don't reintroduce it.
  Need the raw promise pool (transactions, `conn.query`)? `poolOf(db)`.
- Env (see .env.example): DB_*, JWT_SECRET (>=32 chars, fatal if missing), PORT, CORS_ORIGIN,
  PRIVATE_STRIPE_KEY, STRIPE_WEBHOOK_SECRET, GOOGLE_MAPS_API_KEY, FRONTEND_URL,
  SMTP_HOST/PORT/USER/PASS + EMAIL_FROM (emails are logged when SMTP_HOST unset),
  S3_* (uploads fall back to local disk when unset).
- Scripts: npm run dev | start | lint | test (node:test) | migrate.

## Services (src/services)
- `migrationRunner.js` — applies src/migrations/NNN_*.sql at boot and via `npm run migrate`,
  tracked in schema_migrations, tolerates already-exists errors (1050/1060/1061).
  ALL schema changes go through numbered migrations — never inline ALTER at boot.
  Current: 001 baseline (lat/lng, stripe_session_id), 002 notifications, 003 reservation
  reminder, 004 group chats (chats.announcement_id), 005 waitlist, 006 player_ratings,
  007 reservation_share_payments, 008 reservations.split_total, 009 slots.status VARCHAR
  (for 'blocked'), 010 newsletter_subscribers.
- `emailService.js` — SMTP-agnostic (nodemailer), branded templates: password reset, welcome,
  reservation confirmed, J-1 reminder. Fire-and-forget from callers (.catch + log).
- `sseHub.js` — in-memory per-user SSE registry. `push(userId, event, data)`. Single-instance;
  swap for Redis pub/sub if scaling out. Stream route: src/routes/realtime.js (JWT in `Authorization: Bearer`; `?token=` kept as legacy fallback for EventSource clients).
- `storageService.js` — uploads to S3 when configured, local /uploads otherwise. `saveFile()`
  recompresses images on the way in (`compressImage`: sharp, longest side 1600 px, quality 80,
  same format kept so URLs don't change; GIF untouched; any failure returns the original).
  Terrain images go to disk via multer and are recompressed in place in `routes/clubs.js`.
- `cronService.js` — announcement expiration (hourly + 15min) and reservation J-1 reminder
  (daily 09:00, reminder_sent_at guard). Manual run: runJobManually(name).
- `tokenRevocation.js` — in-memory per-user JWT revocation (`revokeUser(id)`); `requireAuth` /
  `verifyToken` (middleware/auth.js, HS256 pinned) refuse tokens issued before. Called on password
  reset, account deletion, role change. Single-instance like sseHub (Redis / `users.tokens_valid_after` to scale).
- `accountService.js` — `anonymizeAccount(db, userId)`: the ONE RGPD deletion path (self + admin).
- Payments: `payments.controller.js` recomputes the price from `terrains.price_per_hour` × duration +
  `config.reservations.serviceFee`; never trust an amount from the browser. `POST /slots/:id/book`
  (no payment) is off unless `ALLOW_DIRECT_BOOKING=true`.
- Public `/auth/register` only creates `player` accounts; club admins come from the invitation flow.

## Notifications
- `src/utils/notify.js` — inserts into notifications AND pushes over SSE. Never throws.
- Emit one for every meaningful social action (friend request/accept, invitation,
  session_join, reservation_confirmed...). Routes: src/routes/notifications.js
  (list, summary = unread notifications + unread messages, read, read-all).

## Middleware / utils
- Error handling: src/middleware/errorHandler.js — AppError, ConflictError, UnauthorizedError, NotFoundError, ValidationError, asyncHandler. Mounted last in index.js.
- Validation: src/middleware/validation.js — validate(schema) middleware + Joi schemas. User roles: 'player' | 'club_admin'.
- Logging: src/utils/logger.js — logger singleton (info/warn/error/debug) + httpLogger middleware (mounted in index.js).
- Auth route: always use asyncHandler + queryOne/insert from dbHelpers. Never raw callback-style db.query.
- queryPromise available for multi-row queries; queryOne for single row; insert returns insertId.
- Tests: use the shared `test/helpers/fakeDb.js` — never hand-roll a `{ query(sql, params, cb) }`
  stub, it lacks `.promise()` and every helper goes through it now.

## Coding standards (enforced)
- ALL route handlers MUST use asyncHandler. Never raw `(req, res) => { db.query(..., (err) => ...) }`.
- Auth: write routes MUST have `requireAuth`. Admin routes MUST have `requireAuth` + `requireClubAdmin`.
- User identity: always read from `req.user.id` (JWT claim). Never from `req.headers['user-id']` or query params.
- Logging: use `logger.debug()` for dev-only logs, `logger.error()` for errors. Never `console.log` in controllers.
- Error responses: throw AppError/NotFoundError/UnauthorizedError — don't return raw `{ error: err }` objects.
- src/middleware/auth.js exports: requireAuth, requireClubAdmin, optionalAuth (sets req.user if valid token, doesn't block).

## General rule
- **NEVER revert a change the user made or removed** — if the user deleted/modified something, do not put it back without being explicitly asked.

## courtside-front adaptation
- React app. Follow existing structure and conventions in courtside-front.
- Use package.json scripts as source of truth.
- Keep API base URL centralized; avoid hardcoded URLs.
