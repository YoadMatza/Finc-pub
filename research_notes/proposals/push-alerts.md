# Push alerts on the phone app

Status: **approved** 2026-11-17 with P1 FCM empty pings, P2 real text fetched from finc, P3 Telegram kept in parallel, P4 one-time codes in the app. **Built and live 2026-11-17** (`3b47ef2`, app vc35 `ae5ade2`): a Firebase project on the free Spark plan (Analytics and Gemini off); the phone registered, a test push reached it and was fetched 6 seconds later. One change from §2: the background receiver uses a per-device push secret (the vault's key needs a fingerprint, which a notification cannot wait for).

## 1. What and why

Every alert finc sends today goes to Telegram: money alerts (large spend, unusual charge, card-bill gap, instalment
purchase, spending limit), sync failures, security alerts, and the one-time-code requests of a bank sync. That works,
but:

- **Telegram sees the full text** of every alert (merchant names, amounts). It is the one place where finc's privacy
  line is crossed on purpose today.
- The phone app already exists, is paired, and pins finc's key; alerts belong there, one tap from the details.
- A one-time code could be typed into the app instead of a chat.

Push alerts add the app as a second channel next to Telegram, per alert type, with the same quiet hours and flood
summary (core alerts/index.ts `dispatchAlerts`, its `matrix[type]`).

## 2. The design: a content-free ping, the details over finc's own connection

```
finc worker ──(1) "wake up" (no content)──▶ push service ──▶ the phone
the phone app ──(2) GET /push/pending (push secret, pinned TLS)──▶ finc ──▶ text, shown as a notification
```

- **The push message carries nothing**: no amount, no merchant, no kind, only "finc has something for you" and a random
  id. The push provider learns that an alert happened and when; nothing else. (Today Telegram learns everything.)
- **The text comes from finc itself**: the app's native code wakes, fetches the pending alerts over the same pinned
  connection and device token it already uses, and shows a normal Android notification with the real text. If it
  cannot reach finc (no network), it shows "finc: new alert, open the app".
- **Tap opens the app** on the alert (a new Alerts screen in the hub, also useful on the web). An OTP request opens a
  code field; the code goes back to the waiting sync (the OTP provider that today reads Telegram also reads this).
- **Revoking the device** (Settings, panic) stops its pushes at once: the push token is stored with the device row and
  dies with it.

## 3. Which push service

| | Firebase Cloud Messaging (Google) | UnifiedPush (e.g. ntfy) |
|---|---|---|
| On the phone | nothing to install (Play services) | the ntfy app as "distributor" |
| Server side | Google's API; a service-account key in the vault | a push server: ntfy.sh, or self-hosted (needs to be reachable from the phone, another public path) |
| App work | official `@capacitor/push-notifications` plus a small native service for the fetch | no Capacitor plugin: a native connector library and plugin of our own |
| Battery | best (one system connection) | one more open connection |
| Who sees what | Google: a token and the timing of empty pings | ntfy.sh or your own server: the same, or nobody if self-hosted |

**Recommendation: FCM with content-free pings.** It is the smallest build and the most reliable delivery, and with an
empty payload Google learns less than Telegram does today. UnifiedPush is the fully self-hosted path, worth it after the
Raspberry Pi move if you want no Google in the loop.

## 4. Safety

- Nothing financial in the push payload, ever (a test asserts the payload's fields).
- The pending-alerts route needs the device token (paired phone) or a hub session; it returns only alerts not yet
  delivered to that device, and marks them delivered.
- The FCM service-account key lives in the vault (`push_fcm`), never in an env var; `google-services.json` (not a
  secret, but tied to your Firebase project) stays out of git like keystore.properties.
- Rate limit and the flood summary apply as for Telegram; quiet hours too, except OTP and urgent alerts.
- Security alerts keep the alarm bot (works while the vault is locked); push for security alerts needs the vault
  (the FCM key), so it is an extra, not a replacement.

## 5. Plan

| # | Step | Done when |
|---|---|---|
| 1 | **You:** create a free Firebase project, add the Android app (`il.finc.app`), download `google-services.json`, create a service-account key; `.\finc vault set push_fcm` | the files exist; nothing committed |
| 2 | **Core:** `push` column in the alert matrix, a delivery queue per device, `/push/pending` (push secret) and `/api/alerts/pending` (device token), push tokens and push-secret hashes on device rows (migration) | unit tests: queue, per-device delivery, revoke drops the token |
| 3 | **Worker:** FCM HTTP v1 sender (OAuth from the service-account key, data-only message, empty payload), wired into `dispatchAlerts`; OTP provider reads app answers too | tests with a fake FCM: payload has no content, quiet hours, flood summary |
| 4 | **App:** push plugin, a native `FirebaseMessagingService` that fetches pending alerts with the device token and posts notifications; Android 13+ notification permission; tap opens the alert / OTP field. New APK (vc35) | on the phone: an alert arrives with its text, app closed |
| 5 | **Hub:** Alerts screen (history, mark seen), Settings → Alerts gets a Push column per type, a "send a test push" button | web tests; seen on the phone |
| 6 | **Docs + live:** external-services.md (Firebase: what is sent), a real money alert and an OTP through the app | you confirm on the phone |

Rough size: two days, most of it steps 3–4. Steps 2 and 5 can go to a helper agent against the route contract.

## 6. Decisions for Yoad

- **P1 Service:** FCM with empty pings (recommended), or UnifiedPush/ntfy.
- **P2 Text:** the real alert text fetched from finc (recommended), or always a generic "new finc alert".
- **P3 Telegram:** keep it in parallel per type (recommended at first), or switch money alerts to push only once push is
  proven.
- **P4 One-time codes in the app:** yes (recommended), or keep codes on Telegram only.

## Sources

- UnifiedPush overview (F-Droid): https://f-droid.org/2022/12/18/unifiedpush.html
- UnifiedPush on push security and privacy: https://unifiedpush.org/news/20250513_push_security_privacy/
- Privacy Guides discussion on FCM metadata and UnifiedPush: https://github.com/orgs/privacyguides/discussions/96
- ntfy as a UnifiedPush server: https://etke.cc/help/extras/ntfy/
