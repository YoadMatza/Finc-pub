# Backup login from outside: PIN + authenticator code (TOTP)

Status: **approved** 2026-11-17 with T1 PIN + code, T2 8 recovery codes, T3 a 12-hour non-admin session, T4 every backup login announced; being built.

## 1. What and why

From outside the home network finc lets in only a **paired phone app** (device token + fingerprint) or a **passkey**
(12-hour session). The PIN works only at home. That leaves a gap the owner decided on 2026-11-10: a computer or browser
without passkey support (a borrowed laptop, an old browser, a work machine that blocks passkeys), or a day when the
phone with the synced passkeys is not at hand. The agreed answer: **PIN + a 6-digit code from Google Authenticator**
(or any TOTP app), as a backup only. Passkeys stay the normal way in.

## 2. How it works

- **Set up at home only** (Settings → Security → Backup login, from the PC or Tailscale, not from a passkey session):
  finc makes a random secret and shows it once as a QR code (`otpauth://totp/finc:<owner>?secret=…&issuer=finc`,
  SHA-1, 6 digits, 30 seconds, what every authenticator app reads). The owner scans it and types one code to confirm;
  only then is it on. **Recovery codes** (P2): 8 single-use codes shown once, for a lost authenticator.
- **Sign in from outside**: the sign-in page offers "Use a passkey" and "PIN + authenticator code". Both fields go in
  one request; finc checks the code (this 30-second step or the one before or after) and the PIN, and opens a session
  like a passkey session: 12 hours, tied to the current PIN, **never admin** (no vault unlock, no device pairing, no
  Settings that the passkey session cannot change either).
- **Every backup login is announced**: an alert on Telegram and on the phone app ("signed in with PIN + code from
  outside"), and a row in the security log.

## 3. Safety

| Threat | Answer |
|---|---|
| Guessing (PIN is short, a code is 6 digits) | Both must be right in one request. A shared failure counter (Docker Desktop hides callers' addresses): 5 wrong tries lock the backup login for 15 minutes, doubling up to 24 hours, with an alert at each lock. Passkeys and the app keep working while it is locked, so a flood cannot lock the owner out of everything. |
| A code seen over the shoulder or phished | A code works once (the last used 30-second step is remembered) and for at most 90 seconds. The PIN is still needed. Phishing a live code + PIN is possible (unlike a passkey): this is why it is a backup, announced every time, and why its session cannot do admin. |
| Someone with the database file | The secret has to be readable without the master password (the vault is locked after every restart, and the backup login must still work). So it sits in the database next to the PIN's hash. Whoever can read the database file can already read all the financial data in it; the secret adds a way in from outside only together with the PIN, whose hash is slow to crack. Noted in SECURITY.md as a limit, like the PIN. |
| A stolen session | 12 hours, not admin, ends when the PIN changes or "Lock everything" runs. |
| "Lock everything" (panic) | Turns the backup login off; turning it on again is home only (a new QR). |
| Turned on by someone else | Setup and turning off need home (PC or Tailscale); a passkey or TOTP session cannot change it. |

Public paths: one new route (`POST /api/auth/totp/login`) reachable through Caddy; the setup routes stay home-only
like the PIN routes (Caddy answers 404 for them outside).

## 4. Plan

| # | Step | Done when |
|---|---|---|
| 1 | **Core:** RFC 6238 TOTP (SHA-1, 6 digits, 30 s, ±1 step), secret generation, last-used step, recovery codes (hashed) | unit tests with the RFC 6238 test vectors, replay refused, window edges |
| 2 | **Worker:** setup (`/api/auth/totp/setup` → QR data, `/confirm`), `/api/auth/totp/login` (PIN + code → a non-admin 12 h session), the lock counter, alerts and security events, panic turns it off, Caddy rules | route tests: from outside only login works; wrong PIN / code / replay / lock; session not admin; panic |
| 3 | **Hub:** Settings → Security → Backup login (QR, confirm, recovery codes, turn off); the sign-in page offers "PIN + code" next to the passkey | web tests; seen in a browser without passkeys |
| 4 | **Live check:** set it up, sign in from a phone browser on mobile data, see the alert, lock it with wrong codes, panic | Yoad confirms |

Rough size: one day. Step 3 can go to a helper agent against the route contract.

## 5. Decisions for Yoad

- **T1 Factors:** PIN + code (recommended, as decided 2026-11-10), or the code alone.
- **T2 Recovery codes:** yes, 8 single-use (recommended), or none (a lost authenticator means setting it up again at
  home).
- **T3 Session:** like a passkey session, 12 hours, never admin (recommended), or shorter (e.g. 2 hours).
- **T4 Alerts:** every backup login announced on Telegram and the app (recommended), or only failures and locks.
