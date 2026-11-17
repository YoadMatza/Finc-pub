package il.finc.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Push alerts (research_notes/proposals/push-alerts.md). The push from Google carries nothing but a random id; on it
 * this service fetches this device's queued alerts from finc ({origin}/push/pending, the push secret, TLS pinned by
 * the network security config like every hub call) and shows each as a notification. Without network it shows a
 * generic "open finc". A one-time-code request opens the app on its code field.
 */
public class FincPushService extends FirebaseMessagingService {
  static final String CHANNEL = "finc_alerts";
  /** the hub path a tapped notification opens (read once by the web side through FincVault.takeLaunchPath) */
  static final String EXTRA_PATH = "finc_path";
  private static final int MAX_SHOWN = 5;

  @Override
  public void onMessageReceived(@NonNull RemoteMessage message) {
    JSONObject reg = PushStore.load(this);
    if (reg == null) return;
    String text;
    try {
      JSONArray items = get(reg.getString("origin") + "/push/pending", reg.getString("secret")).optJSONArray("items");
      if (items == null || items.length() == 0) return;
      int shown = 0;
      for (int i = 0; i < items.length() && shown < MAX_SHOWN; i++, shown++) {
        JSONObject a = items.getJSONObject(i);
        String otp = a.isNull("otpId") ? null : a.optString("otpId", null);
        show(a.optInt("id"), a.optString("text", "finc"), otp, a.optBoolean("urgent", false));
      }
      if (items.length() > MAX_SHOWN) show(-1, "finc: " + (items.length() - MAX_SHOWN) + " more", null, false);
      return;
    } catch (Exception e) {
      text = "finc: new alert — open the app";
    }
    show(0, text, null, false);
  }

  @Override
  public void onNewToken(@NonNull String token) {
    JSONObject reg = PushStore.load(this);
    if (reg == null) return; // not registered yet: the app registers after the next unlock
    try {
      JSONObject body = new JSONObject();
      body.put("token", token);
      post(reg.getString("origin") + "/push/token", reg.getString("secret"), body.toString());
    } catch (Exception ignored) {
      // the next unlock registers again
    }
  }

  private void show(int id, String text, String otpId, boolean urgent) {
    ensureChannel(this);
    Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    open.putExtra(EXTRA_PATH, otpId != null ? "/alerts?otp=" + otpId : "/alerts");
    PendingIntent pi = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("finc")
        .setContentText(text)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
        .setPriority(urgent || otpId != null ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
        // the text shows only once the phone is unlocked
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setAutoCancel(true)
        .setContentIntent(pi);
    try {
      NotificationManagerCompat.from(this).notify(id, b.build());
    } catch (SecurityException e) {
      // notifications not allowed (Android 13+ permission refused): nothing to show
    }
  }

  static void ensureChannel(Context ctx) {
    NotificationManager nm = ctx.getSystemService(NotificationManager.class);
    if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
      NotificationChannel ch = new NotificationChannel(CHANNEL, "finc alerts", NotificationManager.IMPORTANCE_HIGH);
      ch.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
      nm.createNotificationChannel(ch);
    }
  }

  private static JSONObject get(String url, String secret) throws Exception {
    return call(url, "GET", secret, null);
  }

  private static JSONObject post(String url, String secret, String body) throws Exception {
    return call(url, "POST", secret, body);
  }

  private static JSONObject call(String url, String method, String secret, String body) throws Exception {
    HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection();
    try {
      c.setInstanceFollowRedirects(false);
      c.setConnectTimeout(10_000);
      c.setReadTimeout(15_000);
      c.setRequestMethod(method);
      c.setUseCaches(false);
      c.setRequestProperty("authorization", "Bearer " + secret);
      c.setRequestProperty("accept", "application/json");
      if (body != null) {
        c.setDoOutput(true);
        c.setRequestProperty("content-type", "application/json");
        try (OutputStream os = c.getOutputStream()) {
          os.write(body.getBytes(StandardCharsets.UTF_8));
        }
      }
      if (c.getResponseCode() != 200) throw new Exception("status " + c.getResponseCode());
      try (InputStream in = c.getInputStream()) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
          total += n;
          if (total > 1_000_000) throw new Exception("too large");
          out.write(buf, 0, n);
        }
        return new JSONObject(out.toString("UTF-8"));
      }
    } finally {
      c.disconnect();
    }
  }
}
