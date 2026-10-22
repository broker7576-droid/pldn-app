// PLDN-FAYL: PldnAlarmReceiver.java | versiya: lock-4.0 | 22-okt-2026
package __PKG__;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

/**
 * Qulflangan holatda qo'yilgan budilnik/taymer (PLDN'ning o'z budilnigi).
 * Tizim «Soat» ilovasini fondan ochish Android 10+ da cheklangan, shuning uchun
 * AlarmManager.setAlarmClock ishlatiladi: u fonda ham, qulfda ham ishlaydi.
 */
public class PldnAlarmReceiver extends BroadcastReceiver {
    public static final String ACT_FIRE = "pldn.alarm.FIRE";
    public static final String ACT_STOP = "pldn.alarm.STOP";
    static final String CH = "pldn_alarm";

    public static boolean schedule(Context c, long at, String label, boolean timer) {
        try {
            int id = (int) (System.currentTimeMillis() % 1000000000L);
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            Intent i = new Intent(c, PldnAlarmReceiver.class);
            i.setAction(ACT_FIRE);
            i.putExtra("label", label);
            i.putExtra("timer", timer);
            i.putExtra("id", id);
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent op = PendingIntent.getBroadcast(c, id, i, fl);
            PendingIntent show = PendingIntent.getActivity(c, id, new Intent(c, MainActivity.class), fl);
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), op);
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    @Override
    public void onReceive(Context c, Intent in) {
        try {
            String a = in.getAction();
            int id = in.getIntExtra("id", 1);
            int nid = 5000 + (id % 90000);
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (ACT_STOP.equals(a)) { nm.cancel(nid); return; }
            if (!ACT_FIRE.equals(a)) { return; }
            boolean timer = in.getBooleanExtra("timer", false);
            String label = in.getStringExtra("label");
            if (label == null) { label = "PLDN"; }
            Uri snd = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            AudioAttributes aa = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CH, "PLDN budilnik / taymer", NotificationManager.IMPORTANCE_HIGH);
                ch.setSound(snd, aa);
                ch.enableVibration(true);
                ch.setVibrationPattern(new long[]{0, 600, 400, 600, 400, 600});
                nm.createNotificationChannel(ch);
            }
            Intent st = new Intent(c, PldnAlarmReceiver.class);
            st.setAction(ACT_STOP);
            st.putExtra("id", id);
            PendingIntent pStop = PendingIntent.getBroadcast(c, nid, st, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CH) : new Notification.Builder(c);
            b.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(timer ? "\u23F1 PLDN taymer tugadi" : "\u23F0 PLDN budilnik")
                .setContentText(label)
                .setCategory(Notification.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setContentIntent(pStop)
                .addAction(android.R.drawable.ic_media_pause, "To'xtatish", pStop);
            if (Build.VERSION.SDK_INT >= 26) { b.setTimeoutAfter(120000); }
            else { b.setPriority(Notification.PRIORITY_MAX); b.setSound(snd, AudioManager.STREAM_ALARM); b.setVibrate(new long[]{0, 600, 400, 600}); }
            Notification n = b.build();
            n.flags |= Notification.FLAG_INSISTENT;
            nm.notify(nid, n);
        } catch (Throwable e) { }
    }
}
