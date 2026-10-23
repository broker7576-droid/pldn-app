// PLDN-FAYL: PldnPocket.java | versiya: pocket-5.0 | satr: 297 | 23-okt-2026
package __PKG__;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import org.json.JSONObject;

/**
 * 5-bosqich: CHO'NTAK REJIMI.
 * Maqsad: telefon cho'ntakda ekranga tasodifan tegib ketmasin.
 *  1-qatlam: PROXIMITY_SCREEN_OFF_WAKE_LOCK (qo'ng'iroqdagi kabi: sensor yopilsa ekran o'chadi, teginish o'tmaydi).
 *  2-qatlam: shaffofga yaqin «qalqon» oyna (ixtiyoriy, «Boshqa ilovalar ustidan ko'rsatish» ruxsati bilan),
 *            faqat sensor «yaqin» + qorong'i bo'lganda ko'rinadi, sensor ochilishi bilan darhol yo'qoladi.
 *  3-qatlam: PLDN ilovasi ichidagi himoya (index.html «guard» holati).
 * Qulf ekrani/PIN/biometrikaga tegilmaydi. Ekran doim yoqilmaydi. Ovoz yozilmaydi.
 * Rejim faqat PldnWakeService ishlab turganda ishlaydi (xizmat to'xtasa, rejim ham o'chadi).
 */
public class PldnPocket implements SensorEventListener {
    // ---- SOZLAMALAR (sinovda shu yerni to'g'rilaymiz) ----
    static final long NEAR_CONFIRM_MS = 1500;  // sensor shuncha vaqt «yaqin» tursagina cho'ntak deb hisoblanadi
    static final float LUX_DARK = 25f;         // shundan qorong'i bo'lsa qalqon yoqiladi
    static final float LUX_RELEASE = 60f;      // shundan yorug' bo'lsa qalqon olinadi (gisterezis)
    static final String PREF = "pldn_wake";

    public interface Listener { void onPocket(boolean on, boolean guard); }

    // ---- holat (MainActivity va PldnLock o'qiydi) ----
    public static volatile PldnPocket cur = null;
    public static volatile Listener listener = null;
    public static volatile boolean on = false;       // rejim yoniq
    public static volatile boolean near = false;     // sensor «yaqin» (tasdiqlangan)
    public static volatile boolean guard = false;    // himoya faol: yoniq + yaqin + qorong'i
    public static volatile boolean shieldUp = false; // qalqon oyna ko'rinib turibdi
    public static volatile boolean screenOff = false;// proximity wake lock olingan
    public static volatile float lux = -1f;
    public static volatile String note = "";

    final PldnWakeService svc;
    final Handler h = new Handler(Looper.getMainLooper());
    final SensorManager sm;
    final PowerManager pm;
    Sensor prox, light;
    PowerManager.WakeLock wl;
    View shield;
    boolean rawNear = false;
    boolean lightReg = false;
    final Runnable confirm = new Runnable() { public void run() { confirmNear(); } };

    public PldnPocket(PldnWakeService s) {
        svc = s;
        sm = (SensorManager) s.getSystemService(Context.SENSOR_SERVICE);
        pm = (PowerManager) s.getSystemService(Context.POWER_SERVICE);
        try {
            if (Build.VERSION.SDK_INT >= 21) { prox = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY, true); }
            if (prox == null) { prox = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY); }
            light = sm.getDefaultSensor(Sensor.TYPE_LIGHT);
        } catch (Throwable e) { }
        cur = this;
    }

    // ---------- yordamchilar ----------
    SharedPreferences sp() { return svc.getSharedPreferences(PREF, Context.MODE_PRIVATE); }
    boolean shieldPref() { return sp().getBoolean("pocket_shield", true); }

    public static boolean overlayOk(Context c) {
        try { return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c); } catch (Throwable e) { return false; }
    }

    public boolean screenOffSupported() {
        try { return Build.VERSION.SDK_INT >= 21 && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK); }
        catch (Throwable e) { return false; }
    }

    public boolean hasProximity() { return prox != null; }

    void runMain(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) { r.run(); } else { h.post(r); }
    }

    void fire() {
        try { Listener l = listener; if (l != null) { l.onPocket(on, guard); } } catch (Throwable e) { }
        try { svc.refreshRunNotification(); } catch (Throwable e) { }
    }

    // ---------- yoqish / o'chirish ----------
    /** "ok" | "already" | "nosensor". Har qanday oqimdan chaqirsa bo'ladi. */
    public String enable() {
        if (on) { return "already"; }
        if (prox == null) { return "nosensor"; }
        on = true;
        runMain(new Runnable() { public void run() { doEnable(); } });
        return "ok";
    }

    public void disable() {
        if (!on && !shieldUp && !screenOff) { return; }
        on = false;
        runMain(new Runnable() { public void run() { doDisable(); } });
    }

    /** Xizmat o'chganda: hamma narsani bo'shatadi. */
    public void release() {
        on = false;
        runMain(new Runnable() { public void run() { doDisable(); } });
        if (cur == this) { cur = null; }
    }

    /** Sozlama (qalqon yoqish/o'chirish) o'zgarganda holatni qayta baholaydi. */
    public void reeval() {
        runMain(new Runnable() { public void run() { if (on) { eval(); } } });
    }

    void doEnable() {
        if (!on) { return; }
        rawNear = false; near = false; guard = false; lux = -1f; note = "";
        try { sm.registerListener(this, prox, SensorManager.SENSOR_DELAY_NORMAL, h); }
        catch (Throwable e) { note = "Sensor ulanmadi: " + e; on = false; fire(); return; }
        try {
            if (screenOffSupported()) {
                wl = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "PLDN:pocket");
                wl.setReferenceCounted(false);
                wl.acquire();
                screenOff = true;
            }
        } catch (Throwable e) { screenOff = false; }
        fire();
    }

    void doDisable() {
        h.removeCallbacks(confirm);
        try { sm.unregisterListener(this); } catch (Throwable e) { }
        lightReg = false;
        try { if (wl != null && wl.isHeld()) { wl.release(); } } catch (Throwable e) { }
        wl = null;
        screenOff = false;
        hideShield();
        boolean was = guard;
        rawNear = false; near = false; guard = false; lux = -1f;
        on = false;
        fire();
    }

    // ---------- sensorlar ----------
    @Override
    public void onAccuracyChanged(Sensor s, int a) { }

    @Override
    public void onSensorChanged(SensorEvent e) {
        if (!on) { return; }
        try {
            if (e.sensor.getType() == Sensor.TYPE_PROXIMITY) {
                float v = e.values[0];
                float max = e.sensor.getMaximumRange();
                float th = max > 0 ? Math.min(max, 5.0f) : 5.0f; // ikki holatli va masofa beradigan sensorlar uchun
                boolean n = v < th;
                if (n == rawNear) { return; }
                rawNear = n;
                if (n) {
                    startLight();
                    h.removeCallbacks(confirm);
                    h.postDelayed(confirm, NEAR_CONFIRM_MS);
                } else {
                    h.removeCallbacks(confirm);
                    stopLight();
                    near = false;
                    lux = -1f;
                    eval(); // olingan zahoti qalqon yo'qoladi
                }
            } else if (e.sensor.getType() == Sensor.TYPE_LIGHT) {
                lux = e.values[0];
                if (near) { eval(); }
            }
        } catch (Throwable t) { }
    }

    void startLight() {
        if (light == null || lightReg) { return; }
        try {
            sm.registerListener(this, light, SensorManager.SENSOR_DELAY_NORMAL, h);
            lightReg = true;
        } catch (Throwable e) { }
    }

    void stopLight() {
        if (!lightReg) { return; }
        try { sm.unregisterListener(this, light); } catch (Throwable e) { }
        lightReg = false;
    }

    void confirmNear() {
        if (!on || !rawNear) { return; }
        near = true;
        eval();
    }

    /** Himoya faolmi? Yaqin + (yorug'lik sensori yo'q yoki noma'lum yoki qorong'i). */
    void eval() {
        boolean dark = light == null || lux < 0 || lux <= (guard ? LUX_RELEASE : LUX_DARK);
        boolean g = on && near && dark;
        boolean changed = g != guard;
        guard = g;
        boolean wantShield = g && shieldPref() && overlayOk(svc);
        if (wantShield && !shieldUp) { showShield(); }
        else if (!wantShield && shieldUp) { hideShield(); }
        if (changed) { fire(); }
    }

    // ---------- qalqon oyna ----------
    void showShield() {
        try {
            if (shield != null) { return; }
            WindowManager wm = (WindowManager) svc.getSystemService(Context.WINDOW_SERVICE);
            FrameLayout fl = new FrameLayout(svc);
            fl.setBackgroundColor(0xF2000000);
            fl.setClickable(true);
            fl.setOnTouchListener(new View.OnTouchListener() {
                public boolean onTouch(View v, MotionEvent ev) { return true; } // hamma teginishni yutadi
            });
            TextView tv = new TextView(svc);
            tv.setText("\uD83C\uDF92 Cho'ntak rejimi");
            tv.setTextColor(0x99FFFFFF);
            tv.setTextSize(14f);
            tv.setGravity(Gravity.CENTER);
            fl.addView(tv, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
            int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                    | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.LEFT;
            if (Build.VERSION.SDK_INT >= 28) { lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES; }
            wm.addView(fl, lp);
            shield = fl;
            shieldUp = true;
        } catch (Throwable e) {
            shield = null;
            shieldUp = false;
            note = "Qalqon ochilmadi: " + e;
        }
    }

    void hideShield() {
        try {
            if (shield != null) {
                WindowManager wm = (WindowManager) svc.getSystemService(Context.WINDOW_SERVICE);
                wm.removeView(shield);
            }
        } catch (Throwable e) { }
        shield = null;
        shieldUp = false;
    }

    // ---------- JS ko'prigi uchun holat ----------
    public static String statusJson(Context c) {
        try {
            JSONObject o = new JSONObject();
            PldnPocket p = cur;
            o.put("on", on);
            o.put("near", near);
            o.put("guard", guard);
            o.put("shield", shieldUp);
            o.put("screenOff", screenOff);
            o.put("lux", (double) lux);
            o.put("overlay", overlayOk(c));
            o.put("shieldPref", c.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean("pocket_shield", true));
            o.put("service", PldnWakeService.running);
            o.put("note", note);
            boolean hp = false, hl = false;
            try {
                SensorManager m = (SensorManager) c.getSystemService(Context.SENSOR_SERVICE);
                hp = m.getDefaultSensor(Sensor.TYPE_PROXIMITY) != null;
                hl = m.getDefaultSensor(Sensor.TYPE_LIGHT) != null;
            } catch (Throwable e) { }
            o.put("hasProx", hp);
            o.put("hasLight", hl);
            o.put("screenOffOk", p != null ? p.screenOffSupported() : false);
            return o.toString();
        } catch (Throwable e) { return "{}"; }
    }
}
