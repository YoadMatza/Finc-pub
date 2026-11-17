package il.finc.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * Push alerts (research_notes/proposals/push-alerts.md): what the background receiver needs while the app is closed
 * and its vault is locked — the hub's origin and this device's push secret (finc_push_…), which only fetches this
 * device's queued alerts and updates its push token. AES-256-GCM with its own Keystore key that needs NO user
 * authentication (unlike the vault: a notification must not wait for a fingerprint). Clearing the pairing clears it.
 */
final class PushStore {
  private PushStore() {}

  private static final String PREFS = "finc_push";
  private static final String ALIAS = "finc_push_key";

  static synchronized void save(Context ctx, String origin, String secret) throws Exception {
    JSONObject o = new JSONObject();
    o.put("origin", origin);
    o.put("secret", secret);
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.ENCRYPT_MODE, key());
    byte[] enc = c.doFinal(o.toString().getBytes(StandardCharsets.UTF_8));
    prefs(ctx).edit().putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP)).putString("data", Base64.encodeToString(enc, Base64.NO_WRAP)).apply();
  }

  /** {origin, secret}, or null when push is not registered. */
  static synchronized JSONObject load(Context ctx) {
    try {
      SharedPreferences p = prefs(ctx);
      String iv = p.getString("iv", null);
      String data = p.getString("data", null);
      if (iv == null || data == null) return null;
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
      return new JSONObject(new String(c.doFinal(Base64.decode(data, Base64.NO_WRAP)), StandardCharsets.UTF_8));
    } catch (Exception e) {
      return null;
    }
  }

  static synchronized void clear(Context ctx) {
    prefs(ctx).edit().clear().apply();
  }

  private static SharedPreferences prefs(Context ctx) {
    return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static SecretKey key() throws Exception {
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
    KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build());
    return g.generateKey();
  }
}
