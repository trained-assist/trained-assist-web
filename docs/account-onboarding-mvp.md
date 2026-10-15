# Account creation and login: MVP flow

## Product decision

Use Telegram as the first verified sign-in method. New visitors enter email,
display name, and a chosen nickname on the website, then confirm the pending
signup in a private Telegram chat. Returning Telegram identities sign in
without creating a duplicate account. Do not collect a password in the first
iteration. The submitted email is account metadata, not a verified email
address; Telegram confirmation does not prove control of that mailbox.

This keeps the first flow aligned with Telegram identity while allowing the
account to have the user's email and preferred nickname from the beginning.
Email-only login, recovery, and email verification remain out of scope.

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

1. Landing page offers **Create account** and **Log in**. Signup asks for
   email, display name, and nickname before Telegram; login asks only to verify
   the already-linked Telegram identity.
2. The site validates the fields and creates a server-side pending signup.
   The Telegram deep link carries only an opaque, single-use transaction
   reference, never PII, an account token, or a credential.
3. The bot confirms the Telegram sender in a private chat and completes that
   exact transaction server-to-server. A new identity may not claim an
   existing nickname/email or silently take over another Telegram-linked
   account.
4. Provisioning is idempotent and has explicit states: create/attach the
   canonical agent profile, create the Ladder user/key, and apply the approved
   trial policy. Never return an admin credential to the browser or Telegram.
   A Telegram-confirmed account is not shown as ready until required service
   provisioning succeeds.
5. The browser polls the signup transaction through the web BFF. Once Telegram
   confirms it, the BFF claims the handoff once, issues the existing Secure,
   HttpOnly session cookie, and redirects into the app. The browser never
   receives issuer/admin credentials.
6. Email remains explicitly unverified until a separate email challenge is
   implemented. Do not treat it as proof of identity or use it to merge
   accounts.

## Required implementation slices

1. **Identity transaction:** create, poll/complete, expire, and consume
   single-use browser↔Telegram signup transactions; validate/uniquely reserve
   email and nickname; rate-limit creation; store only hashed references; make
   account creation idempotent.
2. **Bot handoff:** handle Telegram deep-link start payloads in private chats,
   verify sender identity, and complete the transaction without requiring the
   legacy `/login` profile for a new account.
3. **Provisioning:** connect Identity to canonical agent profile and Ladder
   user/key creation with bounded retries and a pending-provisioning state. Do
   not report signup success until the account can actually authenticate to the
   requested services.
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
- Paid tiers and dashboard billing. The owner has confirmed a trial allowance
  target of 100 million tokens; implementation must still reconcile this
  against active Ladder enforcement before promising it as a hard quota.

