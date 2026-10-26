// PLDN-FAYL: PldnUploadService.java | versiya: kino-bg-1.0 | satr: 159 | 26-okt-2026
package __PKG__;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Kinozona: kino yuklash paytida ilovani (va WebView'ni) tirik ushlab turadi.
 * Yuklashning o'zi JS'da ketadi; bu xizmat faqat jarayon, protsessor va Wi-Fi uxlab qolmasligini ta'minlaydi.
 */
public class PldnUploadService extends Service {
    public static final String ACT_START = "pldn.kino.up.START";
    public static final String ACT_UPDATE = "pldn.kino.up.UPDATE";
    public static final String ACT_STOP = "pldn.kino.up.STOP";
    public static final String ACT_CANCEL = "pldn.kino.up.CANCEL";
    static final String CH = "pldn_kino_upload";
    static final int NID = 7420;

    public static volatile boolean running = false;
    public static volatile boolean cancelReq = false;
    public static volatile int pct = 0;
    public static volatile String label = "";
    public static volatile String state = "up";

    PowerManager.WakeLock wl;
    WifiManager.WifiLock wfl;
    long lastNotif = 0;

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent i, int flags, int startId) {
        String a = i == null ? null : i.getAction();
        if (a == null) { a = ACT_START; }
        if (ACT_STOP.equals(a)) {
            String res = i == null ? null : i.getStringExtra("res");
            release(); stopForeground(true); running = false; stopSelf();
            if ("done".equals(res) || "failed".equals(res)) { notifyResult("done".equals(res)); }
            return START_NOT_STICKY;
        }
        if (ACT_CANCEL.equals(a)) { cancelReq = true; show(true); return START_NOT_STICKY; }
        if (i != null) {
            if (i.hasExtra("pct")) { pct = i.getIntExtra("pct", pct); }
            if (i.hasExtra("label")) { label = i.getStringExtra("label"); }
            if (i.hasExtra("state")) { state = i.getStringExtra("state"); }
        }
        if (ACT_START.equals(a)) {
            cancelReq = false;
            acquire();
            try {
                Notification n = build();
                if (Build.VERSION.SDK_INT >= 29) { startForeground(NID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); }
                else { startForeground(NID, n); }
                running = true;
            } catch (Throwable e) { running = false; stopSelf(); }
        } else { show(false); }
        return START_NOT_STICKY;
    }

    void acquire() {
        try {
            if (wl == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pldn:kinoup");
                wl.setReferenceCounted(false);
            }
            if (!wl.isHeld()) { wl.acquire(12L * 60 * 60 * 1000); }
        } catch (Throwable e) { }
        try {
            if (wfl == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                wfl = wm.createWifiLock(Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_HIGH_PERF : WifiManager.WIFI_MODE_FULL, "pldn:kinoup");
                wfl.setReferenceCounted(false);
            }
            if (!wfl.isHeld()) { wfl.acquire(); }
        } catch (Throwable e) { }
    }

    void release() {
        try { if (wl != null && wl.isHeld()) { wl.release(); } } catch (Throwable e) { }
        try { if (wfl != null && wfl.isHeld()) { wfl.release(); } } catch (Throwable e) { }
    }

    Notification build() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
            NotificationChannel c = new NotificationChannel(CH, "Kinozona yuklash", NotificationManager.IMPORTANCE_LOW);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) { open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP); }
        int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pi = open == null ? null : PendingIntent.getActivity(this, 1, open, fl);
        Intent ci = new Intent(this, PldnUploadService.class); ci.setAction(ACT_CANCEL);
        PendingIntent cpi = PendingIntent.getService(this, 2, ci, fl);
        String text = "retry".equals(state) ? "Internet kutilmoqda… " + pct + "%" : pct + "%" + (label == null || label.isEmpty() ? "" : " · " + label);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        b.setContentTitle("Kinozona: kino yuklanmoqda")
         .setContentText(text)
         .setSmallIcon(android.R.drawable.stat_sys_upload)
         .setOngoing(true)
         .setOnlyAlertOnce(true)
         .setProgress(100, Math.max(0, Math.min(100, pct)), "init".equals(state))
         .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Bekor qilish", cpi).build());
        if (pi != null) { b.setContentIntent(pi); }
        return b.build();
    }

    /** Yuklash tugagach (ilova fonda bo'lsa ham) oddiy bildirishnoma: yuklandi yoki xato. */
    void notifyResult(boolean ok) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
                NotificationChannel c = new NotificationChannel(CH, "Kinozona yuklash", NotificationManager.IMPORTANCE_LOW);
                nm.createNotificationChannel(c);
            }
            Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
            int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT;
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
            b.setContentTitle(ok ? "Kinozona: kino yuklandi" : "Kinozona: yuklash to'xtadi")
             .setContentText(ok ? "Kino tayyor, xonaga qaytishingiz mumkin." : "Ilovani ochib, qayta urinib ko'ring.")
             .setSmallIcon(ok ? android.R.drawable.stat_sys_upload_done : android.R.drawable.stat_notify_error)
             .setAutoCancel(true);
            if (open != null) { b.setContentIntent(PendingIntent.getActivity(this, 3, open, fl)); }
            nm.notify(NID + 1, b.build());
        } catch (Throwable e) { }
    }

    void show(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastNotif < 1000) { return; }
        lastNotif = now;
        try { ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NID, build()); } catch (Throwable e) { }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // ilova "so'nggi ilovalar"dan olib tashlansa, JS ham o'ladi — yuklash to'xtaydi, bildirishnoma qolib ketmasin
        release(); running = false; stopForeground(true); stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        release(); running = false;
        super.onDestroy();
    }
}
