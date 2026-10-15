# Account creation and login: MVP flow

## Product decision

Use Telegram as the first verified sign-in method. Account creation and login
share one entry point: a verified Telegram identity with no account creates one;
an identity already linked to an account signs in. Do not collect a password in
the first iteration. Email can be added to the account after sign-in and
verified in a later iteration.

This keeps the initial flow aligned with the existing Telegram identity work
and avoids shipping an unverified email/password system before email delivery,
password recovery, and abuse controls exist.

## Current state and gap

- The web login page supports legacy username/password and a Telegram one-time
  code.
- The current Telegram code is issued only after the user has logged into the
  bot with an existing agent profile (`/login <profile> <password>`).
- Identity can bind that verified Telegram subject to an account, but neither
  the website nor bot currently provides self-service first-time signup.
- The Identity and web Telegram-login changes are still draft PRs; this flow is
  not available in production.

Therefore the current one-time-code UI must not be presented as open signup.

## Proposed visitor journey

1. Landing page offers **Create account** and **Log in**. Both lead to the same
   Telegram verification flow; the intent only changes the explanatory copy.
2. The site starts a server-side auth transaction and opens the official bot via
   a Telegram deep link. The link carries an opaque, single-use transaction
   reference, not an account token, email, or credential.
3. The bot confirms the Telegram sender in a private chat and exchanges the
   transaction with Identity server-to-server. A new Telegram subject creates
   an account; an existing subject resolves its existing account. An identity
   already linked elsewhere is never silently moved.
4. For a new account, provisioning is idempotent: create the account, create its
   Ladder user/key through the existing admin-only provisioning API, and apply
   the configured trial policy. Never return the admin credential to the
   browser or Telegram.
5. The browser completes the transaction through the web BFF. The BFF issues
   the existing Secure, HttpOnly session cookie and redirects into the app.
   The browser never receives a Ladder admin key or Telegram issuer secret.
6. After first sign-in, ask for an optional display name and email. Email is
   marked unverified until an email verification flow is implemented.

## Required implementation slices

1. **Identity transaction:** create, poll/complete, expire, and consume
   single-use browser↔Telegram auth transactions; rate-limit creation; store
   only hashed references; make account creation idempotent.
2. **Bot handoff:** handle Telegram deep-link start payloads in private chats,
   verify sender identity, and complete the transaction without requiring the
   legacy `/login` profile for a new account.
3. **Provisioning:** connect Identity to Ladder user/key creation with bounded
   retries and a pending-provisioning state. Do not report signup success until
   the account can actually authenticate to the requested services.
4. **Web UX:** build calm gray create/login screens with explicit waiting,
   success, expired, cancelled, and retry states; add Playwright coverage for
   each state and ensure mobile layouts work.
5. **End-to-end:** deploy isolated sandbox versions of Identity, bot, web, and
   Ladder; test new signup, returning login, duplicate Telegram identity,
   expired handoff, provisioning retry, and session persistence before any
   production rollout.

## Not in the first slice

- Password collection, reset, or email-only login.
- OAuth providers beyond Telegram.
- Paid tiers or dashboard billing.
- Claiming a precise token allowance in the UI until it matches the active
  Ladder trial policy. The proposed marketing target is up to 100 million test
  tokens; the current service limits still need reconciliation before launch.

