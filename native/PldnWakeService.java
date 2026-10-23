// PLDN-FAYL: PldnWakeService.java | versiya: pocket-5.0 | satr: 582 | 23-okt-2026
package __PKG__;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.vosk.LibVosk;
import org.vosk.LogLevel;
import org.vosk.Model;
import org.vosk.Recognizer;

/**
 * PLDN Start uyg'otish xizmati: telefonning o'zida (internetsiz) «Paladin» so'zini kutadi.
 * Ovoz faqat xotirada qayta ishlanadi, hech qayerga yozilmaydi.
 */
public class PldnWakeService extends Service {
    public static final String ACT_START = "pldn.wake.START";
    public static final String ACT_STOP = "pldn.wake.STOP";
    public static final String ACT_POCKET_OFF = "pldn.wake.POCKET_OFF";
    static final String CH_RUN = "pldn_wake_run";
    static final String CH_CMD = "pldn_wake_cmd";
    static final int NID_RUN = 4101;
    static final int NID_CMD = 4102;
    static final String MODEL_ASSET = "vosk-model";

    // ---- SOZLAMALAR (aniqlik yomon bo'lsa shu yerni sozlaymiz) ----
    static final String GRAMMAR = "[\"paladin\", \"[unk]\"]";
    static final boolean USE_GRAMMAR = false; // false: erkin tanish + undosh-skelet moslashuvi (o'zbekcha talaffuzga bardoshli)
    static final double MIN_CONF = 0.50;     // so'zlarning o'rtacha ishonchi (0..1)
    static final int MIN_LETTERS = 3;        // «pee el dee en» dan kamida nechtasi eshitilsin
    static final double MIN_GATE = 300.0;    // ovoz energiyasi chegarasi (tinchlikda protsessorni dam oldiradi)
    static final long HANG_MS = 1200;        // ovoz tugagach shuncha vaqt yana tinglaymiz
    static final int CHUNK = 1600;           // 100 ms (16 kHz)
    static final Set<String> LETTERS = new HashSet<String>(Arrays.asList("p", "pee", "pea", "l", "el", "ell", "d", "dee", "n", "en"));

    // ---- holat (MainActivity o'qiydi) ----
    public static volatile boolean running = false;
    public static volatile String state = "stopped"; // stopped | loading | listening | paused | error
    public static volatile String err = "";
    public static volatile String heard = "";
    public static final String CODE = "pocket-5.0";
    public static volatile int wakes = 0;
    public static volatile String wakeInfo = "";
    public static volatile boolean debug = false;
    public static volatile long holdUntil = 0;

    public interface Sink { boolean onWake(); }
    public static volatile Sink sink = null;

    /** Mikrofonni shu muddatga bo'shatadi (buyruq tinglanayotganda, yozuv/qo'ng'iroq paytida). */
    public static void holdFor(long ms) { holdUntil = SystemClock.elapsedRealtime() + ms; }
    public static void holdMax(long ms) { holdUntil = Math.max(holdUntil, SystemClock.elapsedRealtime() + ms); }

    static class Chunk {
        final short[] d; final int n;
        Chunk(short[] d, int n) { this.d = d; this.n = n; }
    }

    final ArrayBlockingQueue<Chunk> q = new ArrayBlockingQueue<Chunk>(40);
    final Handler main = new Handler(Looper.getMainLooper());
    Thread capThread, decThread;
    volatile boolean stopFlag = false;
    volatile boolean capPaused = false;
    volatile long lastWakeAt = 0;
    PowerManager pm;
    AudioManager am;
    PowerManager.WakeLock wl;
    PldnLock lock;
    public PldnPocket pocket;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        lock = new PldnLock(this);
        pocket = new PldnPocket(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (ACT_STOP.equals(a)) { shutdown(true); return START_NOT_STICKY; }
        if (ACT_POCKET_OFF.equals(a)) {
            try { if (pocket != null) { pocket.disable(); } } catch (Throwable e) { }
            if (!running) { stopSelf(); }
            return START_NOT_STICKY;
        }
        if (intent == null || !ACT_START.equals(a)) { stopSelf(); return START_NOT_STICKY; }
        boolean dbg = intent.getBooleanExtra("debug", false);
        makeChannels();
        try {
            Notification n = runNotification(dbg);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NID_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NID_RUN, n);
            }
        } catch (Throwable e) {
            err = "Xizmatni boshlab bo'lmadi: " + e;
            state = "error";
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        if (running) { return START_NOT_STICKY; }
        debug = dbg;
        err = "";
        heard = "";
        state = "loading";
        running = true;
        stopFlag = false;
        capPaused = false;
        q.clear();
        try {
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PLDN:wake");
            wl.setReferenceCounted(false);
            wl.acquire();
        } catch (Throwable e) { }
        decThread = new Thread(new Runnable() { public void run() { decodeLoop(); } }, "pldn-wake-dec");
        decThread.start();
        return START_NOT_STICKY;
    }

    // ---------- bildirishnomalar ----------
    void makeChannels() {
        if (Build.VERSION.SDK_INT < 26) { return; }
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel a = new NotificationChannel(CH_RUN, "PLDN Start (mikrofon)", NotificationManager.IMPORTANCE_LOW);
            a.setDescription("Uyg'otish iborasini tinglayotganda doimiy ko'rinadi");
            nm.createNotificationChannel(a);
            NotificationChannel b = new NotificationChannel(CH_CMD, "PLDN Start (buyruq)", NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(b);
        } catch (Throwable e) { }
    }

    int piFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
    }

    Notification.Builder builder(String ch) {
        return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, ch) : new Notification.Builder(this);
    }

    Notification runNotification(boolean dbg) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(this, 1, open, piFlags());
        Intent st = new Intent(this, PldnWakeService.class);
        st.setAction(ACT_STOP);
        PendingIntent pStop = PendingIntent.getService(this, 2, st, piFlags());
        Notification.Builder b = builder(CH_RUN);
        boolean pk = PldnPocket.on;
        b.setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(pk ? "🎒 PLDN Start — cho'ntak rejimi yoniq" : "🎙️ PLDN Start — mikrofon yoniq")
            .setContentText(dbg ? "Sinov rejimi: eshitilgan so'zlar ilovada ko'rinadi. Ovoz saqlanmaydi."
                                : "Faqat uyg'otish so'zini («Paladin») kutyapti. Ovoz saqlanmaydi.")
            .setOngoing(true)
            .setContentIntent(pOpen)
            .addAction(android.R.drawable.ic_media_pause, "To'xtatish", pStop);
        if (pk) {
            Intent po = new Intent(this, PldnWakeService.class);
            po.setAction(ACT_POCKET_OFF);
            PendingIntent pPo = PendingIntent.getService(this, 6, po, piFlags());
            b.addAction(android.R.drawable.ic_lock_idle_lock, "Cho'ntak: o'chirish", pPo);
        }
        if (Build.VERSION.SDK_INT < 26) { b.setPriority(Notification.PRIORITY_LOW); }
        if (Build.VERSION.SDK_INT >= 31) {
            try { b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE); } catch (Throwable e) { }
        }
        return b.build();
    }

    /** Cho'ntak rejimi o'zgarganda doimiy bildirishnomani yangilaydi. */
    void refreshRunNotification() {
        main.post(new Runnable() {
            public void run() {
                try {
                    if (!running) { return; }
                    ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NID_RUN, runNotification(debug));
                } catch (Throwable e) { }
            }
        });
    }

    void notifyCmd(String title, String text) {
        try {
            Intent i = new Intent(this, MainActivity.class);
            i.putExtra("pldn_wake", true);
            i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent p = PendingIntent.getActivity(this, 3, i, piFlags());
            Notification.Builder b = builder(CH_CMD);
            b.setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setContentIntent(p);
            if (Build.VERSION.SDK_INT < 26) { b.setPriority(Notification.PRIORITY_HIGH); }
            final NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NID_CMD, b.build());
            main.postDelayed(new Runnable() {
                public void run() { try { nm.cancel(NID_CMD); } catch (Throwable e) { } }
            }, 10000);
        } catch (Throwable e) { }
    }

    /** Qulf rejimi javoblari/davom etish bildirishnomasi. Lock-ekranda matn yashirin (VISIBILITY_PRIVATE). */
    void postAction(String title, String text, PendingIntent tap, long timeoutMs) {
        try {
            makeChannels();
            Notification.Builder pub = builder(CH_CMD);
            pub.setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("PLDN Start");
            Notification.Builder b = builder(CH_CMD);
            b.setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true);
            if (tap != null) { b.setContentIntent(tap); }
            if (Build.VERSION.SDK_INT >= 21) { b.setVisibility(Notification.VISIBILITY_PRIVATE); b.setPublicVersion(pub.build()); }
            if (Build.VERSION.SDK_INT >= 26) { b.setTimeoutAfter(timeoutMs); }
            else { b.setPriority(Notification.PRIORITY_HIGH); }
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NID_CMD, b.build());
        } catch (Throwable e) { }
    }

    // ---------- model ----------
    File ensureModel() throws Exception {
        File dir = new File(getFilesDir(), "vosk-model");
        File ok = new File(dir, ".ok");
        if (ok.exists() && new File(dir, "conf/model.conf").exists()) { return dir; }
        deleteRec(dir);
        copyAssets(MODEL_ASSET, dir);
        new FileOutputStream(ok).close();
        return dir;
    }

    void deleteRec(File f) {
        if (f == null || !f.exists()) { return; }
        File[] l = f.listFiles();
        if (l != null) { for (File c : l) { deleteRec(c); } }
        f.delete();
    }

    void copyAssets(String path, File out) throws Exception {
        String[] l = getAssets().list(path);
        if (l != null && l.length > 0) {
            out.mkdirs();
            for (String s : l) { copyAssets(path + "/" + s, new File(out, s)); }
            return;
        }
        InputStream in;
        try { in = getAssets().open(path); } catch (FileNotFoundException e) { out.mkdirs(); return; }
        OutputStream os = new FileOutputStream(out);
        byte[] b = new byte[65536];
        int n;
        while ((n = in.read(b)) > 0) { os.write(b, 0, n); }
        os.close();
        in.close();
    }

    // ---------- tanish (past ustuvorlikdagi oqim) ----------
    void decodeLoop() {
        Model model = null;
        Recognizer rec = null;
        try {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
            LibVosk.setLogLevel(LogLevel.WARNINGS);
            File dir = ensureModel();
            model = new Model(dir.getAbsolutePath());
            rec = USE_GRAMMAR ? new Recognizer(model, 16000.0f, GRAMMAR) : new Recognizer(model, 16000.0f);
            rec.setWords(true);
            capThread = new Thread(new Runnable() { public void run() { captureLoop(); } }, "pldn-wake-cap");
            capThread.start();

            short[] prev = null;
            int prevN = 0;
            boolean active = false, wasHold = false;
            double noise = 150.0;
            long lastVoice = 0;
            while (!stopFlag) {
                Chunk c = q.poll(400, TimeUnit.MILLISECONDS);
                if (capPaused) {
                    if (!wasHold) { rec.reset(); active = false; q.clear(); prev = null; wasHold = true; }
                    continue;
                }
                wasHold = false;
                if (c == null) { continue; }
                double r = rms(c.d, c.n);
                double gate = Math.max(MIN_GATE, noise * 2.5);
                boolean voice = r > gate;
                if (!voice) { noise = Math.min(1500.0, noise * 0.97 + r * 0.03); }
                long now = SystemClock.elapsedRealtime();
                if (voice) { lastVoice = now; }
                boolean act = (now - lastVoice) < HANG_MS;
                if (act) {
                    if (!active && prev != null) { rec.acceptWaveForm(prev, prevN); }
                    active = true;
                    if (rec.acceptWaveForm(c.d, c.n)) {
                        if (handle(rec.getResult())) { rec.reset(); active = false; q.clear(); prev = null; continue; }
                    }
                } else if (active) {
                    active = false;
                    boolean w = handle(rec.getFinalResult());
                    rec.reset();
                    if (w) { q.clear(); prev = null; continue; }
                }
                prev = c.d;
                prevN = c.n;
            }
        } catch (InterruptedException ie) {
            // to'xtatilmoqda
        } catch (Throwable e) {
            if (!stopFlag) {
                err = String.valueOf(e);
                state = "error";
                main.post(new Runnable() { public void run() { failStop(); } });
            }
        } finally {
            try { if (rec != null) { rec.close(); } } catch (Throwable e) { }
            try { if (model != null) { model.close(); } } catch (Throwable e) { }
        }
    }

    static double rms(short[] d, int n) {
        double s = 0;
        for (int i = 0; i < n; i++) { s += (double) d[i] * d[i]; }
        return Math.sqrt(s / Math.max(1, n));
    }

    boolean handle(String json) {
        try {
            JSONObject o = new JSONObject(json);
            String text = o.optString("text", "").trim();
            if (text.length() == 0 || "[unk]".equals(text)) { return false; }
            double conf = 1.0;
            JSONArray ws = o.optJSONArray("result");
            if (ws != null && ws.length() > 0) {
                double s = 0;
                for (int i = 0; i < ws.length(); i++) { s += ws.getJSONObject(i).optDouble("conf", 1.0); }
                conf = s / ws.length();
            }
            if (debug) { heard = text + " (" + Math.round(conf * 100) + "%)"; }
            if (SystemClock.elapsedRealtime() - lastWakeAt < 4000) { return false; }
            if (!isWake(text, conf)) { return false; }
            heard = text + " (" + Math.round(conf * 100) + "%)";
            onWake();
            return true;
        } catch (Throwable e) { return false; }
    }

    /** Unli harflarsiz skelet: «pe le dinstart», «pee el dee en start», «p l d n start» -> «pldnstrt». */
    static String skel(String t) {
        return t.toLowerCase().replaceAll("[^a-z]", "").replaceAll("[aeiouy]", "");
    }

    /** Skelet «pldnstrt» ga 1 ta harf farq bilan (tushib qolgan yoki almashgan) yaqin bo'lsa ham mos deymiz. */
    static boolean near(String sk) {
        final String tg = "pldnstrt";
        for (int len = tg.length() - 1; len <= tg.length() + 1; len++) {
            for (int i = 0; i + len <= sk.length(); i++) {
                if (lev(sk.substring(i, i + len), tg) <= 1) { return true; }
            }
        }
        return false;
    }

    static int lev(String a, String b) {
        int[] p = new int[b.length() + 1];
        int[] c = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) { p[j] = j; }
        for (int i = 1; i <= a.length(); i++) {
            c[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                c[j] = Math.min(Math.min(c[j - 1] + 1, p[j] + 1), p[j - 1] + cost);
            }
            int[] t = p; p = c; c = t;
        }
        return p[b.length()];
    }

    /** Uyg'otish so'zi: «Paladin» (undosh skeleti «pldn»): paladin, palladin, paladen, pladin, «pal a din» ... */
    static boolean isWake(String text, double conf) {
        if (conf < MIN_CONF) { return false; }
        String t = text.toLowerCase().replaceAll("[^a-z ]", " ").trim().replaceAll("\\s+", " ");
        if (t.length() == 0) { return false; }
        String[] ws = t.split(" ");
        for (String w : ws) {
            String k = skel(w).replaceAll("(.)\\1+", "$1");
            if (k.equals("pldn") || k.equals("pldns")) { return true; }
        }
        if (ws.length <= 3) { // «pal a din» kabi bo'laklab eshitilsa
            String k = skel(t).replaceAll("(.)\\1+", "$1");
            if (k.equals("pldn")) { return true; }
        }
        return false;
    }

    void onWake() {
        lastWakeAt = SystemClock.elapsedRealtime();
        wakes++;
        beep();
        boolean interactive = true, locked = false;
        try { interactive = pm.isInteractive(); } catch (Throwable e) { }
        try { locked = ((KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE)).isKeyguardLocked(); } catch (Throwable e) { }
        holdFor(15000);
        Sink s = sink;
        boolean done = false;
        if (interactive && !locked && s != null) {
            try { done = s.onWake(); } catch (Throwable e) { done = false; }
        }
        wakeInfo = "#" + wakes + " ekran=" + interactive + " qulf=" + locked + " ilova=" + (s != null) + " JSga=" + done;
        if (!done) {
            // Ilova oldinda emas yoki telefon qulflangan: qulfni chetlab o'tmaymiz.
            holdFor(4000);
            if (getSharedPreferences("pldn_wake", Context.MODE_PRIVATE).getBoolean("lock_on", true)) {
                // 4-bosqich: qulfsiz amallar mahalliy bajariladi, qolganlari telefon ochilgach davom etadi
                main.post(new Runnable() { public void run() { try { lock.start(); } catch (Throwable e) { } } });
            } else if (!interactive || locked) {
                notifyCmd("PLDN Start", "Telefon qulflangan. Bosing, qulfni ochgach buyruqni tinglayman.");
            } else {
                notifyCmd("PLDN Start", "Buyruqni aytish uchun bosing.");
            }
        }
    }

    void beep() {
        try {
            final ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_MUSIC, 60);
            tg.startTone(ToneGenerator.TONE_PROP_BEEP, 150);
            main.postDelayed(new Runnable() { public void run() { try { tg.release(); } catch (Throwable e) { } } }, 400);
        } catch (Throwable e) { }
    }

    // ---------- mikrofon (yuqori ustuvorlikdagi oqim) ----------
    boolean inCall() {
        try {
            int m = am.getMode();
            return m == AudioManager.MODE_IN_CALL || m == AudioManager.MODE_IN_COMMUNICATION || m == AudioManager.MODE_RINGTONE;
        } catch (Throwable e) { return false; }
    }

    AudioRecord openRecord() {
        try {
            int min = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int bs = Math.max(min, CHUNK * 2 * 4);
            AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bs);
            if (r.getState() != AudioRecord.STATE_INITIALIZED) { r.release(); return null; }
            r.startRecording();
            if (r.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) { r.release(); return null; }
            return r;
        } catch (Throwable e) { return null; }
    }

    void closeRecord(AudioRecord r) {
        if (r == null) { return; }
        try { r.stop(); } catch (Throwable e) { }
        try { r.release(); } catch (Throwable e) { }
    }

    void captureLoop() {
        try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO); } catch (Throwable e) { }
        AudioRecord ar = null;
        while (!stopFlag) {
            try {
                boolean hold = SystemClock.elapsedRealtime() < holdUntil || inCall();
                if (hold) {
                    capPaused = true;
                    state = "paused";
                    if (ar != null) { closeRecord(ar); ar = null; }
                    Thread.sleep(250);
                    continue;
                }
                if (ar == null) {
                    ar = openRecord();
                    if (ar == null) {
                        capPaused = true;
                        state = "paused";
                        err = "Mikrofonni ochib bo'lmadi (band bo'lishi mumkin), qayta urinaman";
                        Thread.sleep(1500);
                        continue;
                    }
                    err = "";
                    capPaused = false;
                    state = "listening";
                }
                short[] d = new short[CHUNK];
                int n = ar.read(d, 0, CHUNK);
                if (n <= 0) {
                    closeRecord(ar);
                    ar = null;
                    Thread.sleep(500);
                    continue;
                }
                Chunk c = new Chunk(d, n);
                if (!q.offer(c)) { q.poll(); q.offer(c); }
            } catch (InterruptedException ie) {
                break;
            } catch (Throwable e) {
                closeRecord(ar);
                ar = null;
                try { Thread.sleep(500); } catch (InterruptedException ie2) { break; }
            }
        }
        closeRecord(ar);
    }

    // ---------- to'xtatish ----------
    void stopAll() {
        stopFlag = true;
        try { if (pocket != null) { pocket.disable(); } } catch (Throwable e) { }
        Thread t1 = capThread, t2 = decThread;
        if (t1 != null) { t1.interrupt(); }
        if (t2 != null) { t2.interrupt(); }
        try { if (t1 != null) { t1.join(800); } } catch (Throwable e) { }
        try { if (t2 != null) { t2.join(800); } } catch (Throwable e) { }
        try { if (wl != null && wl.isHeld()) { wl.release(); } } catch (Throwable e) { }
    }

    void shutdown(boolean byUser) {
        if (byUser) {
            try { getSharedPreferences("pldn_wake", Context.MODE_PRIVATE).edit().putBoolean("on", false).apply(); } catch (Throwable e) { }
        }
        stopAll();
        running = false;
        state = "stopped";
        try { stopForeground(true); } catch (Throwable e) { }
        stopSelf();
    }

    void failStop() {
        stopAll();
        running = false; // state «error» saqlanadi, ilova sababini ko'rsatadi
        try { stopForeground(true); } catch (Throwable e) { }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        try { if (lock != null) { lock.release(); } } catch (Throwable e) { }
        try { if (pocket != null) { pocket.release(); } } catch (Throwable e) { }
        stopAll();
        running = false;
        if (!"error".equals(state)) { state = "stopped"; }
        super.onDestroy();
    }
}
