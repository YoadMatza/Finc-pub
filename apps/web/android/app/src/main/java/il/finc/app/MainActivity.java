package il.finc.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Android 15+ draws the app edge to edge, under the status bar and the navigation bar. The hub is a
 * normal page, not a full-screen canvas, so keep it inside the system bars (and above the keyboard)
 * by padding the activity's content root with the window insets. The listener has to sit on the
 * root: Capacitor's CoordinatorLayout does not forward insets to the WebView.
 *
 * FLAG_SECURE (P1-11): balances must not show in the recent-apps thumbnail, screenshots, screen
 * recordings or casting. It is set before anything is drawn. FincVault is registered before
 * super.onCreate, as Capacitor requires for local plugins.
 */
public class MainActivity extends BridgeActivity {
  private static final int BG = Color.parseColor("#0F1115");

  @Override
  public void onCreate(Bundle savedInstanceState) {
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    registerPlugin(FincVaultPlugin.class);
    super.onCreate(savedInstanceState);
    ViewGroup content = findViewById(android.R.id.content);
    View root = content.getChildCount() > 0 ? content.getChildAt(0) : content;
    root.setBackgroundColor(BG);
    getWindow().getDecorView().setBackgroundColor(BG);
    ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
      Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
      return WindowInsetsCompat.CONSUMED;
    });
    ViewCompat.requestApplyInsets(root);
  }
}
