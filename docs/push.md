# Alerts on the phone app (push)

finc can wake its phone app when an alert is due (a large charge, an unusual one, a failed sync, a bank asking for a
one-time code). It works next to Telegram: each alert type has a Telegram and an App switch in Settings → Alerts.

**What goes through Google:** nothing about the alert. finc sends Firebase Cloud Messaging an empty wake-up (a random
id); the app then fetches the alert text from finc itself, over its pinned connection, and shows it. Google learns that
finc had something for the phone, and when. (Telegram, by comparison, carries the full text.)

## Setup (once)

1. **Firebase project** (free): console.firebase.google.com → Add project (Analytics off is fine).
2. **Add the Android app**: package name `il.finc.app`. Download `google-services.json` and put it in
   `apps/web/android/app/` (it is git-ignored). Build the app again (`gradlew assembleRelease`) and install it.
3. **Service-account key** (for finc to send): Project settings → Service accounts → Generate new private key. Put the
   JSON file in finc's `data` folder, then on the PC:

   ```
   .\finc push setup <file-name>.json
   ```

   It stores the key in the vault (entry `push_fcm`) and deletes the file. Lock and unlock the vault so the worker reads
   it.
4. **Open the phone app and unlock it** once: it asks for permission to show notifications and registers.
5. Settings → Alerts → **Send a test push**.

## How it is kept safe

- The push payload never holds an alert (a test checks every field Firebase receives).
- The app's background receiver uses its own narrow secret (`finc_push_…`), good only for this phone's queued alerts
  and its push token; it is replaced at every registration, and removing the device (or the panic button) ends it.
  finc stores only its hash. The phone keeps it in a Keystore key of its own (the vault's key needs your fingerprint,
  which a notification cannot wait for).
- Notifications are private on the lock screen (text shown only when the phone is unlocked).
- One-time codes: a waiting bank sync takes the first answer, from the app's code field or from Telegram.
