// PLDN-FAYL: PldnLock.java | versiya: pocket-5.0 | satr: 945 | 23-okt-2026
package __PKG__;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.telecom.TelecomManager;
import android.telephony.SmsManager;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * PLDN Start: qulflangan (yoki ilova yopiq) holatda ishlovchi «mahalliy miya».
 * Faqat qulfsiz bajarsa bo'ladigan amallar: qo'ng'iroq, SMS, budilnik, taymer, ovoz balandligi.
 * Qolgan hamma narsa (chat, xabar yozish, ilovalar...) telefon ochilgach davom ettiriladi.
 * Qulfni ochish/PIN kiritish yo'q: foydalanuvchi telefonni o'zi ochadi. Ovoz yozuvlari saqlanmaydi.
 */
public class PldnLock {
    static final int M_CMD = 0, M_YN = 1, M_TEXT = 2, M_NAME = 3;
    static final int CI = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;

    // ---- qulf ochilgach davom ettiriladigan buyruq (MainActivity token bilan oladi) ----
    public static volatile String pendCmd = null;
    public static volatile String pendTok = null;
    public static volatile long pendAt = 0;

    public static synchronized String takeCmd(String tok) {
        String c = pendCmd;
        if (c != null && tok != null && tok.equals(pendTok) && System.currentTimeMillis() - pendAt < 5 * 60 * 1000L) {
            pendCmd = null;
            pendTok = null;
            return c;
        }
        return null;
    }

    interface ContactAct { void run(Contact c, String num); }
    interface TextAct { void run(String t); }

    static class Contact {
        String name;
        int score;
        ArrayList<String> nums = new ArrayList<String>();
        HashSet<String> keys = new HashSet<String>();
    }

    static class Tok {
        int num = -1;
        String w = null;
    }

    static class Once implements Runnable {
        final Runnable r;
        boolean done = false;
        Once(Runnable r) { this.r = r; }
        public void run() {
            if (done) { return; }
            done = true;
            if (r != null) { r.run(); }
        }
    }

    final PldnWakeService svc;
    final Handler h = new Handler(Looper.getMainLooper());
    SpeechRecognizer sr;
    TextToSpeech tts;
    boolean ttsReady = false;
    volatile Once curOnce = null;
    String pendSpeakText = null;
    Runnable pendSpeakThen = null;
    boolean active = false;
    int sid = 0;
    int mode = M_CMD;
    boolean ru = false;
    boolean reAsked = false;
    int ynTries = 0;
    Runnable yesAct = null;
    ContactAct nameAct = null;
    ArrayList<Contact> nameCands = null;
    TextAct textAct = null;
    BroadcastReceiver unlockRcv = null;
    Runnable listenTimeout = null;

    public PldnLock(PldnWakeService s) { svc = s; }

    SharedPreferences sp() { return svc.getSharedPreferences("pldn_wake", Context.MODE_PRIVATE); }
    String T(String uz, String r) { return ru ? r : uz; }
    boolean perm(String p) { return ContextCompat.checkSelfPermission(svc, p) == PackageManager.PERMISSION_GRANTED; }
    boolean isLocked() {
        try { return ((KeyguardManager) svc.getSystemService(Context.KEYGUARD_SERVICE)).isKeyguardLocked(); } catch (Throwable e) { return true; }
    }
    void info(String title, String text) { svc.postAction(title, text, null, 15000); }
    Runnable g(final Runnable r) {
        final int my = sid;
        return new Runnable() { public void run() { if (active && sid == my) { r.run(); } } };
    }

    // =====================================================================
    //  SEANS
    // =====================================================================
    public void start() {
        if (active) { return; }
        active = true;
        sid++;
        reAsked = false;
        ru = "ru".equals(sp().getString("lang", "uz"));
        PldnWakeService.holdFor(35000);
        final int my = sid;
        info("PLDN Start", T("\uD83C\uDF99 Eshityapman\u2026", "\uD83C\uDF99 Слушаю\u2026"));
        h.postDelayed(new Runnable() { public void run() { if (active && sid == my) { listen(M_CMD); } } }, 600);
        h.postDelayed(new Runnable() { public void run() { if (active && sid == my) { end(); } } }, 90000);
    }

    void end() {
        active = false;
        sid++;
        cancelTimeout();
        killRec();
        try { if (tts != null) { tts.stop(); } } catch (Throwable e) { }
        yesAct = null; nameAct = null; nameCands = null; textAct = null;
        PldnWakeService.holdFor(500);
    }

    public void release() {
        active = false;
        sid++;
        cancelTimeout();
        killRec();
        disarm();
        try { if (tts != null) { tts.stop(); tts.shutdown(); tts = null; } } catch (Throwable e) { }
    }

    // =====================================================================
    //  OVOZ: TTS
    // =====================================================================
    void say(String text, Runnable then) { speak(text, then == null ? null : g(then)); }
    void sayEnd(String text) { speak(text, g(new Runnable() { public void run() { end(); } })); }

    void speak(final String text, final Runnable then) {
        info("PLDN Start", text);
        if (tts == null) {
            pendSpeakText = text;
            pendSpeakThen = then;
            tts = new TextToSpeech(svc, new TextToSpeech.OnInitListener() {
                public void onInit(int st) {
                    ttsReady = (st == TextToSpeech.SUCCESS);
                    if (ttsReady) { setupTts(); }
                    final String x = pendSpeakText;
                    final Runnable t = pendSpeakThen;
                    pendSpeakText = null;
                    pendSpeakThen = null;
                    h.post(new Runnable() { public void run() { doSpeak(x == null ? "" : x, t); } });
                }
            });
            return;
        }
        doSpeak(text, then);
    }

    void setupTts() {
        try {
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                public void onStart(String id) { }
                public void onDone(String id) { Once o = curOnce; if (o != null) { h.post(o); } }
                public void onError(String id) { Once o = curOnce; if (o != null) { h.post(o); } }
            });
        } catch (Throwable e) { }
    }

    void doSpeak(String text, Runnable then) {
        final Once o = new Once(then);
        curOnce = o;
        if (then != null) { h.postDelayed(o, 9000); }
        if (!ttsReady || text.length() == 0) { if (then != null) { h.postDelayed(o, 400); } return; }
        try {
            Locale loc = ru ? new Locale("ru", "RU") : new Locale("uz", "UZ");
            if (tts.isLanguageAvailable(loc) < TextToSpeech.LANG_AVAILABLE) {
                // ovoz paketi yo'q: javob bildirishnomada matn ko'rinishida qoladi
                if (then != null) { h.postDelayed(o, 500); }
                return;
            }
            tts.setLanguage(loc);
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "pldnlock");
        } catch (Throwable e) {
            if (then != null) { h.postDelayed(o, 300); }
        }
    }

    // =====================================================================
    //  OVOZ: TANISH
    // =====================================================================
    void killRec() {
        try {
            if (sr != null) {
                sr.setRecognitionListener(null);
                sr.cancel();
                sr.destroy();
            }
        } catch (Throwable e) { }
        sr = null;
    }

    void cancelTimeout() {
        if (listenTimeout != null) { h.removeCallbacks(listenTimeout); listenTimeout = null; }
    }

    void listen(int m) {
        mode = m;
        killRec();
        cancelTimeout();
        PldnWakeService.holdFor(30000);
        if (!perm(Manifest.permission.RECORD_AUDIO)) { sayEnd(T("Mikrofon ruxsati yo'q.", "Нет доступа к микрофону.")); return; }
        if (!SpeechRecognizer.isRecognitionAvailable(svc)) { sayEnd(T("Telefonda ovoz tanish xizmati yo'q.", "Нет службы распознавания речи.")); return; }
        final int my = sid;
        try {
            sr = SpeechRecognizer.createSpeechRecognizer(svc);
            sr.setRecognitionListener(new RecognitionListener() {
                public void onReadyForSpeech(Bundle p) { }
                public void onBeginningOfSpeech() { }
                public void onRmsChanged(float v) { }
                public void onBufferReceived(byte[] b) { }
                public void onEndOfSpeech() { }
                public void onEvent(int t, Bundle b) { }
                public void onPartialResults(Bundle b) { }
                public void onError(final int code) {
                    h.post(new Runnable() { public void run() { if (active && sid == my) { onErr(code); } } });
                }
                public void onResults(Bundle b) {
                    final ArrayList<String> l = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    h.post(new Runnable() {
                        public void run() {
                            if (active && sid == my) {
                                cancelTimeout();
                                onTexts(l == null ? new ArrayList<String>() : l);
                            }
                        }
                    });
                }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, ru ? "ru-RU" : "uz-UZ");
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 4);
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, svc.getPackageName());
            sr.startListening(i);
            listenTimeout = new Runnable() { public void run() { if (active && sid == my) { killRec(); onErr(6); } } };
            h.postDelayed(listenTimeout, 12000);
        } catch (Throwable e) {
            sayEnd(T("Tinglashni boshlab bo'lmadi.", "Не удалось начать прослушивание."));
        }
    }

    void onErr(int code) {
        cancelTimeout();
        killRec();
        if (code == 6 || code == 7) {
            if (mode == M_YN && ynTries < 1) {
                ynTries++;
                say(T("Ha yoki yo'q deb ayting.", "Скажите «да» или «нет»."), new Runnable() { public void run() { listen(M_YN); } });
                return;
            }
            sayEnd(T("Hech narsa eshitmadim.", "Ничего не услышал."));
        } else if (code == 1 || code == 2) {
            sayEnd(T("Internet yo'q: ovoz tanish internet talab qiladi.", "Нет интернета: распознавание требует сеть."));
        } else if (code == 8) {
            sayEnd(T("Mikrofon band.", "Микрофон занят."));
        } else if (code == 9) {
            sayEnd(T("Mikrofon ruxsati yo'q.", "Нет доступа к микрофону."));
        } else {
            sayEnd(T("Tanishda xatolik (kod " + code + ").", "Ошибка распознавания (код " + code + ")."));
        }
    }

    void onTexts(ArrayList<String> l) {
        if (mode == M_CMD) { onCmd(l); }
        else if (mode == M_YN) { onYn(l); }
        else if (mode == M_TEXT) { onText(l); }
        else if (mode == M_NAME) { onName(l); }
        else { end(); }
    }

    // =====================================================================
    //  MATN YORDAMCHILARI
    // =====================================================================
    static String unify(String s) {
        return s == null ? "" : s.replaceAll("[\u02bb\u02bc\u2018\u2019\u0060\u00b4]", "'");
    }

    static String norm(String s) {
        if (s == null) { return ""; }
        String t = s.toLowerCase(Locale.ROOT);
        t = t.replaceAll("[\u02bb\u02bc\u2018\u2019\u0060\u00b4']", "");
        t = t.replace('\u0451', '\u0435');
        t = t.replaceAll("(\\d)[:.](\\d)", "$1 $2");
        t = t.replaceAll("[^\\p{L}\\p{N}]+", " ").trim();
        return t;
    }

    static boolean has(String n, String re) {
        return Pattern.compile("(?:^| )(?:" + re + ")(?: |$)", Pattern.UNICODE_CASE).matcher(n).find();
    }

    static final Pattern WAKE = Pattern.compile("^\\s*(?:hey\\s+|hay\\s+)?(?:paladin|paladen|paladyn|palladin|pladin|pladen|peladin|\u043f\u0430\u043b\u0430\u0434\u0438\u043d|pldn\\s*start|p\\.?\\s?l\\.?\\s?d\\.?\\s?n\\.?\\s*start)[\\s,.!:\\-]*", CI);

    static final Pattern NEEDS = Pattern.compile("(?:^| )(?:och\\p{L}*|chat\\p{L}*|suhbat\\p{L}*|xabar\\p{L}*|habar\\p{L}*|yoz\\p{L}*|bot\\p{L}*|kontakt\\p{L}*|sozlama\\p{L}*|profil\\p{L}*|kamera\\p{L}*|rasm\\p{L}*|foto|selfi|wifi|wi|bluetooth|bluetuz|oxirgi|keyingi|oldingi|\u043e\u0442\u043a\u0440\u043e\u0439\\p{L}*|\u0437\u0430\u043f\u0443\u0441\u0442\u0438\\p{L}*|\u043d\u0430\u043f\u0438\u0448\u0438|\u0432\u043a\u043b\u044e\u0447\u0438\\p{L}*|\u043a\u0430\u043c\u0435\u0440\\p{L}*|\u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\\p{L}*|\u0447\u0430\u0442\\p{L}*)(?: |$)", Pattern.UNICODE_CASE);

    static final String CALLRE = "qongiroq\\p{L}*|zvonok\\p{L}*|pozvoni\\p{L}*|chaqir\\p{L}*|call|\u043f\u043e\u0437\u0432\u043e\u043d\u0438\\p{L}*|\u0437\u0432\u043e\u043d\u0438\\p{L}*|\u043d\u0430\u0431\u0435\u0440\u0438\\p{L}*|\u0432\u044b\u0437\u043e\u0432\u0438\\p{L}*";
    static final String FILLRE = "qil|qilib|qilgin|qiling|et|etgin|eting|ber|bering|iltimos|menga|marhamat|\u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430|ga|ka|qa|ni|ning";

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

    static int tokScore(String a, String b) {
        if (a.equals(b)) { return 100; }
        int la = a.length(), lb = b.length();
        if (lb >= 3 && a.startsWith(b) && la - lb <= 3) { return 92; }
        if (la >= 3 && b.startsWith(a) && lb - la <= 2) { return 85; }
        int mn = Math.min(la, lb);
        if (mn >= 4) {
            int d = lev(a, b);
            if (d <= 1) { return 80; }
            if (d <= 2 && mn >= 7) { return 65; }
        }
        return 0;
    }

    static int nameScore(String qn, String nn) {
        if (qn.length() == 0 || nn.length() == 0) { return 0; }
        String[] q = qn.split(" ");
        String[] t = nn.split(" ");
        int sum = 0;
        for (String x : q) {
            int best = 0;
            for (String y : t) { best = Math.max(best, tokScore(x, y)); }
            sum += best;
        }
        return sum / q.length;
    }

    // ---- son va vaqt (index.html 2-bosqich bilan bir xil mantiq) ----
    static final HashMap<String, Integer> NW = new HashMap<String, Integer>();
    static {
        String[] k = {"nol", "bir", "ikki", "uch", "tort", "besh", "olti", "yetti", "sakkiz", "toqqiz", "on", "yigirma", "ottiz", "qirq", "ellik", "oltmish", "yetmish", "sakson", "toqson"};
        int[] v = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90};
        for (int i = 0; i < k.length; i++) { NW.put(k[i], v[i]); }
    }

    static List<Tok> items(String n) {
        ArrayList<Tok> out = new ArrayList<Tok>();
        int cur = -1;
        for (String w : n.split(" ")) {
            if (w.length() == 0) { continue; }
            if (w.matches("\\d+") && w.length() < 9) {
                if (cur >= 0) { Tok t = new Tok(); t.num = cur; out.add(t); cur = -1; }
                Tok t2 = new Tok(); t2.num = Integer.parseInt(w); out.add(t2);
            } else if (NW.containsKey(w)) {
                int v = NW.get(w);
                if (cur >= 20 && cur % 10 == 0 && v > 0 && v < 10) { cur += v; }
                else {
                    if (cur >= 0) { Tok t = new Tok(); t.num = cur; out.add(t); }
                    cur = v;
                }
            } else {
                if (cur >= 0) { Tok t = new Tok(); t.num = cur; out.add(t); cur = -1; }
                Tok t3 = new Tok(); t3.w = w; out.add(t3);
            }
        }
        if (cur >= 0) { Tok t = new Tok(); t.num = cur; out.add(t); }
        return out;
    }

    static int unitOf(String w) {
        if (w.matches("(?:soat\\p{L}*|chas\\p{L}*|\u0447\u0430\u0441\\p{L}*)")) { return 3600; }
        if (w.matches("(?:daqiqa\\p{L}*|minut\\p{L}*|min|\u043c\u0438\u043d\u0443\u0442\\p{L}*|\u043c\u0438\u043d)")) { return 60; }
        if (w.matches("(?:soniya\\p{L}*|sekund\\p{L}*|sek|\u0441\u0435\u043a\u0443\u043d\u0434\\p{L}*|\u0441\u0435\u043a)")) { return 1; }
        return 0;
    }

    /** {soniya, yolg'iz son (yoki -1)} */
    static int[] parseDur(String n) {
        int num = -1, total = 0;
        boolean half = false;
        for (Tok x : items(n)) {
            if (x.w == null) { num = x.num; continue; }
            if (x.w.equals("yarim") || x.w.equals("polovina")) { half = true; continue; }
            int u = unitOf(x.w);
            if (u > 0) {
                if (num >= 0) { total += num * u; if (half) { total += u / 2; } }
                else if (half) { total += u / 2; }
                num = -1;
                half = false;
            }
        }
        return new int[]{total, num};
    }

    static int[] parseClock(String n) {
        ArrayList<Integer> nums = new ArrayList<Integer>();
        boolean half = false;
        for (Tok x : items(n)) {
            if (x.w == null) { nums.add(x.num); }
            else if (x.w.equals("yarim")) { half = true; }
        }
        if (nums.isEmpty()) { return null; }
        boolean pm = has(n, "kechqurun|kechasi|kech|kechki|tushdan keyin|tushdan songra|vechera|vecherom|dnya|dnem|\u0432\u0435\u0447\u0435\u0440\u0430|\u0434\u043d\u044f");
        boolean am = has(n, "ertalab|tongda|tong|erta|tunda|utra|utrom|nochi|\u0443\u0442\u0440\u0430|\u043d\u043e\u0447\u0438");
        int hh = nums.get(0), mm = 0;
        if (nums.size() >= 2 && nums.get(1) < 60) { mm = nums.get(1); }
        else if (nums.size() == 1 && hh >= 100 && hh < 2400) { mm = hh % 100; hh = hh / 100; }
        if (half) { mm = 30; }
        if (hh > 23 || mm > 59) { return null; }
        if (pm && hh < 12) { hh += 12; }
        if (am && hh == 12) { hh = 0; }
        return new int[]{hh, mm};
    }

    static String pad(int n) { return (n < 10 ? "0" : "") + n; }

    // =====================================================================
    //  BUYRUQ
    // =====================================================================
    void onCmd(ArrayList<String> texts) {
        ArrayList<String> raws = new ArrayList<String>();
        boolean wakeOnly = false;
        for (String t : texts) {
            if (t == null) { continue; }
            String u = unify(t).trim();
            String s = WAKE.matcher(u).replaceFirst("").trim().replaceAll("[.!?]+$", "").trim();
            if (s.length() == 0) { if (u.length() > 0) { wakeOnly = true; } continue; }
            raws.add(s);
        }
        if (raws.isEmpty()) {
            if (wakeOnly && !reAsked) {
                reAsked = true;
                say(T("Eshityapman, buyruqni ayting.", "Слушаю, назовите команду."), new Runnable() { public void run() { listen(M_CMD); } });
                return;
            }
            sayEnd(T("Hech narsa eshitmadim.", "Ничего не услышал."));
            return;
        }
        for (String s : raws) { if (tryCmd(s, norm(s))) { return; } }
        String f = raws.get(0);
        if (NEEDS.matcher(norm(f)).find()) { needUnlock(f); return; }
        sayEnd(T("Buyruqni tushunmadim.", "Команду не понял."));
    }

    // ---------- 5-bosqich: CHO'NTAK REJIMI (qulfsiz, mahalliy) ----------
    static final String POCKET_RE = "cho ?ntak\\p{L}*|chu ?ntak\\p{L}*|pocket|\u0447\u043e\u043d\u0442\u0430\u043a\\p{L}*|\u0447\u045e\u043d\u0442\u0430\u043a\\p{L}*|\u0447\u0443\u043d\u0442\u0430\u043a\\p{L}*|\u043a\u0430\u0440\u043c\u0430\u043d\\p{L}*|\u0432 \u043a\u0430\u0440\u043c\u0430\u043d\u0435";

    void doPocket(String n) {
        boolean off = has(n, "ochir\\p{L}*|tugat\\p{L}*|toxtat\\p{L}*|bekor\\p{L}*|stop|\u0432\u044b\u043a\u043b\u044e\u0447\\p{L}*|\u043e\u0442\u043a\u043b\u044e\u0447\\p{L}*|\u0443\u0431\u0435\u0440\\p{L}*");
        boolean onn = has(n, "yoq\\p{L}*|faol\\p{L}*|boshla\\p{L}*|\u0432\u043a\u043b\u044e\u0447\\p{L}*|\u0430\u043a\u0442\u0438\u0432\\p{L}*");
        PldnPocket p = svc.pocket;
        if (p == null) { sayEnd(T("Cho'ntak rejimi hozir mavjud emas.", "Режим «в кармане» сейчас недоступен.")); return; }
        if (!off && !onn) {
            sayEnd(T("Yoqish uchun «cho'ntak rejimini yoq», o'chirish uchun «cho'ntak rejimini o'chir» deng.", "Скажите «включи режим в кармане» или «выключи режим в кармане»."));
            return;
        }
        if (off) {
            p.disable();
            sayEnd(T("Cho'ntak rejimi o'chirildi.", "Режим «в кармане» выключен."));
            return;
        }
        String r = p.enable();
        if ("nosensor".equals(r)) {
            sayEnd(T("Bu telefonda yaqinlik sensori yo'q, cho'ntak rejimini yoqib bo'lmaydi.", "На этом телефоне нет датчика приближения, режим включить нельзя."));
        } else if ("already".equals(r)) {
            sayEnd(T("Cho'ntak rejimi allaqachon yoniq.", "Режим «в кармане» уже включён."));
        } else {
            boolean so = p.screenOffSupported();
            boolean ov = PldnPocket.overlayOk(svc) && sp().getBoolean("pocket_shield", true);
            String tail = "";
            if (!so && !ov) { tail = T(" Diqqat: bu telefonda ekranni o'chirish ishlamaydi va qalqon ruxsati yo'q, himoya cheklangan.", " Внимание: защита ограничена."); }
            sayEnd(T("Cho'ntak rejimi yoqildi.", "Режим «в кармане» включён.") + tail);
        }
    }

    boolean tryCmd(String un, String n) {
        if (has(n, POCKET_RE)) { doPocket(n); return true; }
        boolean csOk = !isLocked() || sp().getBoolean("lock_cs", true);
        if (has(n, "sms\\p{L}*|\u0441\u043c\u0441\\p{L}*")) {
            if (!csOk) { needUnlock(un); } else { trySms(un); }
            return true;
        }
        if (has(n, CALLRE)) {
            if (!csOk) { needUnlock(un); } else { tryCall(n); }
            return true;
        }
        if (has(n, "budilnik\\p{L}*|\u0431\u0443\u0434\u0438\u043b\u044c\u043d\u0438\u043a\\p{L}*")) { return tryAlarm(n); }
        if (has(n, "taymer\\p{L}*|timer|\u0442\u0430\u0439\u043c\u0435\u0440\\p{L}*")) { return tryTimer(n); }
        if (has(n, "ovoz\\p{L}*|tovush\\p{L}*|zvuk|\u0437\u0432\u0443\u043a|\u0433\u0440\u043e\u043c\u043a\u043e\u0441\u0442\\p{L}*")
            && !has(n, "ovozli|xabar|habar|\u0433\u043e\u043b\u043e\u0441\u043e\u0432\\p{L}*")) {
            doVolume(n);
            return true;
        }
        return false;
    }

    // ---------- qulfni ochishni talab qiladigan buyruq ----------
    void needUnlock(String text) {
        boolean locked = isLocked();
        armContinue(text);
        sayEnd(locked
            ? T("Bu amal uchun telefonni oching. Ochgach bildirishnomani bosing, davom etaman.", "Для этого разблокируйте телефон. После разблокировки нажмите уведомление, и я продолжу.")
            : T("Davom etish uchun bildirishnomani bosing.", "Чтобы продолжить, нажмите уведомление."));
    }

    void armContinue(final String text) {
        disarm();
        pendCmd = text;
        pendTok = java.util.UUID.randomUUID().toString();
        pendAt = System.currentTimeMillis();
        final String tok = pendTok;
        if (!isLocked()) { postContinue(text); return; }
        unlockRcv = new BroadcastReceiver() {
            public void onReceive(Context c, Intent it) {
                disarm();
                if (tok.equals(pendTok)) { postContinue(text); }
            }
        };
        ContextCompat.registerReceiver(svc, unlockRcv, new IntentFilter(Intent.ACTION_USER_PRESENT), ContextCompat.RECEIVER_NOT_EXPORTED);
        h.postDelayed(new Runnable() {
            public void run() {
                if (tok.equals(pendTok) && unlockRcv != null) { disarm(); pendCmd = null; pendTok = null; }
            }
        }, 5 * 60 * 1000L);
    }

    void disarm() {
        try { if (unlockRcv != null) { svc.unregisterReceiver(unlockRcv); } } catch (Throwable e) { }
        unlockRcv = null;
    }

    void postContinue(String text) {
        try {
            Intent i = new Intent(svc, MainActivity.class);
            i.putExtra("pldn_tok", pendTok);
            i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent p = PendingIntent.getActivity(svc, 5, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            svc.postAction("PLDN Start", "\u00AB" + text + "\u00BB \u2014 " + T("davom ettirish uchun bosing", "нажмите, чтобы продолжить"), p, 5 * 60 * 1000L);
        } catch (Throwable e) { }
    }

    // ---------- ha / yo'q ----------
    void confirm(String q, Runnable yes) {
        yesAct = yes;
        ynTries = 0;
        say(q, new Runnable() { public void run() { listen(M_YN); } });
    }

    void onYn(ArrayList<String> l) {
        for (String t : l) {
            String n = norm(t);
            if (n.length() == 0) { continue; }
            if (has(n, "yoq|yoqq|bekor\\p{L}*|toxta\\p{L}*|no|\u043d\u0435\u0442|\u043d\u0435|\u043e\u0442\u043c\u0435\u043d\u0430|\u0441\u0442\u043e\u043f|\u043e\u0442\u043c\u0435\u043d\u0438\\p{L}*")) {
                sayEnd(T("Bekor qilindi.", "Отменено."));
                return;
            }
        }
        for (String t : l) {
            String n = norm(t);
            if (n.length() == 0) { continue; }
            if (has(n, "ha|xa|haa|ok|okey|yaxshi|bajar\\p{L}*|davom\\p{L}*|tasdiqla\\p{L}*|yubor\\p{L}*|qil|qiling|yes|\u0434\u0430|\u0434\u0430\u0432\u0430\u0439|\u0430\u0433\u0430|\u0445\u043e\u0440\u043e\u0448\u043e|\u043e\u043a")) {
                Runnable y = yesAct;
                yesAct = null;
                if (y != null) { y.run(); } else { end(); }
                return;
            }
        }
        if (ynTries < 1) {
            ynTries++;
            say(T("Ha yoki yo'q deb ayting.", "Скажите «да» или «нет»."), new Runnable() { public void run() { listen(M_YN); } });
        } else {
            sayEnd(T("Tushunmadim, bekor qilindi.", "Не понял, отменено."));
        }
    }

    void onText(ArrayList<String> l) {
        TextAct a = textAct;
        textAct = null;
        String t = "";
        for (String x : l) { if (x != null && x.trim().length() > 0) { t = unify(x).trim(); break; } }
        if (t.length() == 0 || a == null) { sayEnd(T("Matnni eshitmadim.", "Текст не услышан.")); return; }
        a.run(t);
    }

    // ---------- kontakt ----------
    ArrayList<Contact> findAll() {
        LinkedHashMap<String, Contact> map = new LinkedHashMap<String, Contact>();
        Cursor c = null;
        try {
            c = svc.getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER},
                null, null, null);
            if (c != null) {
                while (c.moveToNext()) {
                    String nm = c.getString(0);
                    String num = c.getString(1) == null ? "" : c.getString(1).replaceAll("[^0-9+*#]", "");
                    if (nm == null || num.length() < 3) { continue; }
                    String nk = norm(nm);
                    if (nk.length() == 0) { continue; }
                    Contact ct = map.get(nk);
                    if (ct == null) { ct = new Contact(); ct.name = nm; map.put(nk, ct); }
                    String key = num.replace("+", "");
                    if (key.length() > 9) { key = key.substring(key.length() - 9); }
                    if (ct.keys.add(key)) { ct.nums.add(num); }
                }
            }
        } catch (Throwable e) {
        } finally {
            try { if (c != null) { c.close(); } } catch (Throwable e2) { }
        }
        return new ArrayList<Contact>(map.values());
    }

    static String tail(String num) {
        String d = num.replaceAll("[^0-9]", "");
        return d.length() > 4 ? d.substring(d.length() - 4) : d;
    }

    void withContact(final String qname, final ContactAct act) {
        String qn = norm(qname);
        if (qn.length() == 0) {
            nameAct = act;
            nameCands = null;
            say(T("Kimga?", "Кому?"), new Runnable() { public void run() { listen(M_NAME); } });
            return;
        }
        if (!perm(Manifest.permission.READ_CONTACTS)) {
            sayEnd(T("Kontaktlarga ruxsat yo'q. Ilovani ochib ruxsat bering.", "Нет доступа к контактам. Откройте приложение и дайте доступ."));
            return;
        }
        ArrayList<Contact> all = findAll();
        ArrayList<Contact> c = new ArrayList<Contact>();
        for (Contact x : all) {
            x.score = nameScore(qn, norm(x.name));
            if (x.score >= 60 && !x.nums.isEmpty()) { c.add(x); }
        }
        Collections.sort(c, new Comparator<Contact>() { public int compare(Contact a, Contact b) { return b.score - a.score; } });
        if (c.isEmpty()) {
            sayEnd(T("\u00AB" + qname + "\u00BB kontaktlarda topilmadi.", "\u00AB" + qname + "\u00BB не найден в контактах."));
            return;
        }
        if (c.size() == 1 || c.get(0).score - c.get(1).score >= 15) {
            act.run(c.get(0), c.get(0).nums.get(0));
            return;
        }
        nameAct = act;
        nameCands = new ArrayList<Contact>(c.subList(0, Math.min(3, c.size())));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < nameCands.size(); i++) { if (i > 0) { sb.append(", "); } sb.append(nameCands.get(i).name); }
        say(T("Qaysi biri: " + sb + "? Ismini aniq ayting.", "Какой именно: " + sb + "? Назовите точнее."), new Runnable() { public void run() { listen(M_NAME); } });
    }

    void onName(ArrayList<String> l) {
        ContactAct a = nameAct;
        ArrayList<Contact> cands = nameCands;
        nameAct = null;
        nameCands = null;
        String t = "";
        for (String x : l) { if (x != null && x.trim().length() > 0) { t = unify(x).trim(); break; } }
        if (t.length() == 0 || a == null) { sayEnd(T("Ismni eshitmadim.", "Имя не услышано.")); return; }
        if (cands == null) { withContact(t, a); return; }
        String qn = norm(t);
        Contact best = null, second = null;
        for (Contact x : cands) {
            x.score = nameScore(qn, norm(x.name));
            if (best == null || x.score > best.score) { second = best; best = x; }
            else if (second == null || x.score > second.score) { second = x; }
        }
        if (best != null && best.score >= 60 && (second == null || best.score - second.score >= 15)) {
            a.run(best, best.nums.get(0));
        } else {
            sayEnd(T("Aniqlay olmadim, bekor qilindi.", "Не смог уточнить, отменено."));
        }
    }

    // ---------- QO'NG'IROQ ----------
    void tryCall(String n) {
        StringBuilder sb = new StringBuilder();
        for (String w : n.split(" ")) {
            if (w.length() == 0) { continue; }
            if (w.matches("(?:" + CALLRE + ")") || w.matches("(?:" + FILLRE + ")")) { continue; }
            if (sb.length() > 0) { sb.append(' '); }
            sb.append(w);
        }
        startCall(sb.toString());
    }

    void startCall(String name) {
        withContact(name, new ContactAct() {
            public void run(final Contact c, final String num) {
                confirm(T("\u00AB" + c.name + "\u00BB (\u2026" + tail(num) + ") ga qo'ng'iroq qilaymi?", "Позвонить \u00AB" + c.name + "\u00BB (\u2026" + tail(num) + ")?"),
                    new Runnable() { public void run() { placeCall(num, c.name); } });
            }
        });
    }

    void placeCall(String num, String label) {
        if (!perm(Manifest.permission.CALL_PHONE)) {
            sayEnd(T("Qo'ng'iroq ruxsati yo'q. Ilovani ochib ruxsat bering.", "Нет разрешения на звонки. Откройте приложение и дайте доступ."));
            return;
        }
        boolean ok = false;
        try {
            TelecomManager tm = (TelecomManager) svc.getSystemService(Context.TELECOM_SERVICE);
            tm.placeCall(Uri.fromParts("tel", num, null), new Bundle());
            ok = true;
        } catch (Throwable e) { ok = false; }
        if (!ok) {
            try {
                Intent i = new Intent(Intent.ACTION_CALL, Uri.fromParts("tel", num, null));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                svc.startActivity(i);
                ok = true;
            } catch (Throwable e) { ok = false; }
        }
        info("PLDN Start", ok ? "\uD83D\uDCDE " + label : T("Qo'ng'iroq qilib bo'lmadi.", "Не удалось позвонить."));
        end();
    }

    // ---------- SMS ----------
    static final String SV = "(?:yoz\\p{L}*|yubor\\p{L}*|jo'?nat\\p{L}*)";
    static final Pattern SMS1 = Pattern.compile("^(.+?)\\s*(?:ga|ka|qa)\\s+(.+?)\\s+deb\\s+sms\\p{L}*\\s*" + SV + "$", CI);
    static final Pattern SMS2 = Pattern.compile("^(.+?)\\s*(?:ga|ka|qa)\\s+sms\\p{L}*\\s+" + SV + "(?:\\s*[:,]?\\s*(.*))?$", CI);
    static final Pattern SMS3 = Pattern.compile("^sms\\p{L}*\\s+" + SV + "\\s+(.+?)\\s*(?:ga|ka|qa)(?:\\s+(.+))?$", CI);
    static final Pattern SMS4 = Pattern.compile("^(.+?)\\s*(?:ga|ka|qa)\\s+sms\\p{L}*$", CI);
    static final Pattern SMS5 = Pattern.compile("^(?:\u043d\u0430\u043f\u0438\u0448\u0438|\u043e\u0442\u043f\u0440\u0430\u0432\u044c)\\s+\u0441\u043c\u0441\\s+(\\S+)\\s+(.+)$", CI);
    static final Pattern SMS6 = Pattern.compile("^\u0441\u043c\u0441\\s+(\\S+)\\s+(.+)$", CI);

    void trySms(String un) {
        java.util.regex.Matcher m;
        String name = "", text = "";
        if ((m = SMS1.matcher(un)).matches()) { name = m.group(1); text = m.group(2); }
        else if ((m = SMS2.matcher(un)).matches()) { name = m.group(1); text = m.group(2) == null ? "" : m.group(2); }
        else if ((m = SMS3.matcher(un)).matches()) { name = m.group(1); text = m.group(2) == null ? "" : m.group(2); }
        else if ((m = SMS4.matcher(un)).matches()) { name = m.group(1); }
        else if ((m = SMS5.matcher(un)).matches()) { name = m.group(1); text = m.group(2); }
        else if ((m = SMS6.matcher(un)).matches()) { name = m.group(1); text = m.group(2); }
        startSms(name.trim(), text.trim());
    }

    void startSms(String name, final String text) {
        withContact(name, new ContactAct() {
            public void run(final Contact c, final String num) {
                if (text.length() > 0) { confirmSms(c, num, text); return; }
                textAct = new TextAct() { public void run(String t) { confirmSms(c, num, t); } };
                say(T("Nima deb yozay?", "Что написать?"), new Runnable() { public void run() { listen(M_TEXT); } });
            }
        });
    }

    void confirmSms(final Contact c, final String num, final String text) {
        confirm(T("\u00AB" + c.name + "\u00BB (\u2026" + tail(num) + ") ga SMS yuboraymi: \u00AB" + text + "\u00BB?", "Отправить SMS \u00AB" + c.name + "\u00BB (\u2026" + tail(num) + "): \u00AB" + text + "\u00BB?"),
            new Runnable() { public void run() { sendSms(num, text, c.name); } });
    }

    void sendSms(String num, String text, final String label) {
        if (!perm(Manifest.permission.SEND_SMS)) {
            sayEnd(T("SMS ruxsati yo'q. Ilovani ochib ruxsat bering.", "Нет разрешения на SMS. Откройте приложение и дайте доступ."));
            return;
        }
        try {
            SmsManager sm = android.os.Build.VERSION.SDK_INT >= 31 ? svc.getSystemService(SmsManager.class) : SmsManager.getDefault();
            ArrayList<String> parts = sm.divideMessage(text);
            final String act = "pldn.lock.sms." + System.nanoTime();
            final int[] left = {parts.size()};
            final int[] fail = {0};
            BroadcastReceiver rc = new BroadcastReceiver() {
                public void onReceive(Context c, Intent it) {
                    if (getResultCode() != Activity.RESULT_OK) { fail[0] = getResultCode(); }
                    left[0] = left[0] - 1;
                    if (left[0] <= 0) {
                        try { svc.unregisterReceiver(this); } catch (Throwable e) { }
                        info("PLDN Start", fail[0] == 0 ? "\u2713 SMS: " + label : T("SMS yuborilmadi (kod " + fail[0] + ").", "SMS не отправлено (код " + fail[0] + ")."));
                    }
                }
            };
            ContextCompat.registerReceiver(svc, rc, new IntentFilter(act), ContextCompat.RECEIVER_NOT_EXPORTED);
            ArrayList<PendingIntent> sent = new ArrayList<PendingIntent>();
            for (int k = 0; k < parts.size(); k++) {
                Intent si = new Intent(act);
                si.setPackage(svc.getPackageName());
                sent.add(PendingIntent.getBroadcast(svc, 800 + k, si, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            }
            if (parts.size() > 1) { sm.sendMultipartTextMessage(num, null, parts, sent, null); }
            else { sm.sendTextMessage(num, null, text, sent.get(0), null); }
            info("PLDN Start", T("SMS yuborilmoqda\u2026", "SMS отправляется\u2026"));
            end();
        } catch (Throwable e) {
            sayEnd(T("SMS yuborib bo'lmadi.", "Не удалось отправить SMS."));
        }
    }

    // ---------- BUDILNIK / TAYMER (PLDN'ning o'z budilnigi; qulfda tizim «Soat» ilovasini ocholmaymiz) ----------
    int[] alarmTime(String n) {
        int[] rel = parseDur(n);
        if (rel[0] > 0 && has(n, "keyin\\p{L}*|songra|song|cherez|\u0447\u0435\u0440\u0435\u0437")) {
            Calendar c = Calendar.getInstance();
            c.setTimeInMillis(System.currentTimeMillis() + rel[0] * 1000L + 59000L);
            return new int[]{c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE)};
        }
        return parseClock(n);
    }

    boolean tryAlarm(String n) {
        if (has(n, "ochir\\p{L}*|bekor|royxat\\p{L}*|korsat\\p{L}*|och|ochib|udali\\p{L}*|otmen\\p{L}*|\u043f\u043e\u043a\u0430\u0436\u0438\\p{L}*|\u0441\u043f\u0438\u0441\u043e\u043a|\u043e\u0442\u043a\u0440\u043e\u0439\\p{L}*")) { return false; }
        int[] t = alarmTime(n);
        if (t == null) {
            textAct = new TextAct() {
                public void run(String x) {
                    int[] t2 = alarmTime(norm(x));
                    if (t2 == null) { sayEnd(T("Vaqtni tushunmadim.", "Не понял время.")); } else { setAlarm(t2[0], t2[1]); }
                }
            };
            say(T("Budilnik soat nechiga?", "На сколько поставить будильник?"), new Runnable() { public void run() { listen(M_TEXT); } });
            return true;
        }
        setAlarm(t[0], t[1]);
        return true;
    }

    void setAlarm(int hh, int mm) {
        Calendar c = Calendar.getInstance();
        c.set(Calendar.HOUR_OF_DAY, hh);
        c.set(Calendar.MINUTE, mm);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        if (c.getTimeInMillis() <= System.currentTimeMillis()) { c.add(Calendar.DAY_OF_MONTH, 1); }
        String hm = pad(hh) + ":" + pad(mm);
        if (PldnAlarmReceiver.schedule(svc, c.getTimeInMillis(), hm, false)) {
            sayEnd(T("Budilnik " + hm + " ga qo'yildi.", "Будильник на " + hm + "."));
        } else {
            sayEnd(T("Budilnik qo'yib bo'lmadi.", "Не удалось поставить будильник."));
        }
    }

    boolean tryTimer(String n) {
        if (has(n, "ochir\\p{L}*|bekor|toxtat\\p{L}*|royxat\\p{L}*|korsat\\p{L}*|och|ochib|otmen\\p{L}*|ostanov\\p{L}*|\u043e\u0442\u043c\u0435\u043d\\p{L}*|\u043e\u0442\u043a\u0440\u043e\u0439\\p{L}*")) { return false; }
        int[] d = parseDur(n);
        int sec = d[0];
        if (sec == 0 && d[1] >= 0) { sec = d[1] * 60; }
        if (sec <= 0) {
            textAct = new TextAct() {
                public void run(String x) {
                    int[] d2 = parseDur(norm(x));
                    int s2 = d2[0];
                    if (s2 == 0 && d2[1] >= 0) { s2 = d2[1] * 60; }
                    if (s2 <= 0) { sayEnd(T("Vaqtni tushunmadim.", "Не понял время.")); } else { setTimer(s2); }
                }
            };
            say(T("Taymer necha daqiqaga?", "На сколько минут таймер?"), new Runnable() { public void run() { listen(M_TEXT); } });
            return true;
        }
        setTimer(sec);
        return true;
    }

    void setTimer(int sec) {
        if (sec > 86400) { sayEnd(T("Taymer 24 soatdan oshmasligi kerak.", "Таймер не может быть больше 24 часов.")); return; }
        int h2 = sec / 3600, m2 = (sec % 3600) / 60, s2 = sec % 60;
        String d = (h2 > 0 ? h2 + T(" soat ", " ч ") : "") + (m2 > 0 ? m2 + T(" daqiqa ", " мин ") : "") + (s2 > 0 ? s2 + T(" soniya", " сек") : "");
        d = d.trim();
        if (PldnAlarmReceiver.schedule(svc, System.currentTimeMillis() + sec * 1000L, d, true)) {
            sayEnd(T("Taymer " + d + "ga qo'yildi.", "Таймер на " + d + "."));
        } else {
            sayEnd(T("Taymer qo'yib bo'lmadi.", "Не удалось поставить таймер."));
        }
    }

    // ---------- OVOZ BALANDLIGI ----------
    void doVolume(String n) {
        int st = AudioManager.STREAM_MUSIC;
        if (has(n, "qongiroq\\p{L}*|rington|zvonok\\p{L}*|\u0437\u0432\u043e\u043d\u043e\u043a|\u0437\u0432\u043e\u043d\u043a\\p{L}*")) { st = AudioManager.STREAM_RING; }
        int pct = -1;
        for (Tok t : items(n)) { if (t.w == null && t.num <= 100) { pct = t.num; break; } }
        String op = null;
        if (pct >= 0) { op = "set"; }
        else if (has(n, "ochir\\p{L}*|jim|mute|ovozsiz|\u0432\u044b\u043a\u043b\u044e\u0447\\p{L}*")) { op = "mute"; pct = 0; }
        else if (has(n, "toliq|maksimal\\p{L}*|eng baland|full|maksimum|\u043c\u0430\u043a\u0441\u0438\u043c\u0443\u043c")) { op = "set"; pct = 100; }
        else if (has(n, "kamaytir\\p{L}*|pasayt\\p{L}*|past\\p{L}*|tushir\\p{L}*|kamay\\p{L}*|pasay\\p{L}*|\u0442\u0438\u0448\u0435|\u0443\u0431\u0430\u0432\\p{L}*|\u0443\u043c\u0435\u043d\u044c\u0448\\p{L}*")) { op = "down"; pct = 0; }
        else if (has(n, "oshir\\p{L}*|baland\\p{L}*|kotar\\p{L}*|kuchaytir\\p{L}*|\u0433\u0440\u043e\u043c\u0447\u0435|\u043f\u0440\u0438\u0431\u0430\u0432\\p{L}*|\u0443\u0432\u0435\u043b\u0438\u0447\\p{L}*")) { op = "up"; pct = 0; }
        else if (has(n, "yoq\\p{L}*")) { op = "set"; pct = 50; }
        if (op == null) {
            sayEnd(T("Tushunmadim. Masalan: ovozni 50 foizga qo'y.", "Не понял. Например: громкость 50 процентов."));
            return;
        }
        try {
            AudioManager am = (AudioManager) svc.getSystemService(Context.AUDIO_SERVICE);
            int max = am.getStreamMaxVolume(st);
            int cur = am.getStreamVolume(st);
            int step = Math.max(1, Math.round(max * (pct > 0 ? pct : 20) / 100f));
            int v = cur;
            if ("set".equals(op)) { v = Math.round(Math.max(0, Math.min(100, pct)) * max / 100f); }
            else if ("up".equals(op)) { v = Math.min(max, cur + step); }
            else if ("down".equals(op)) { v = Math.max(0, cur - step); }
            else if ("mute".equals(op)) { v = 0; }
            am.setStreamVolume(st, v, AudioManager.FLAG_SHOW_UI);
            int shown = Math.round(v * 100f / max);
            sayEnd(T("Ovoz " + shown + " foiz.", "Громкость " + shown + "%."));
        } catch (Throwable e) {
            sayEnd(T("Ovozni o'zgartirib bo'lmadi (Bezovta qilmang rejimi yoqilgan bo'lishi mumkin).", "Не удалось изменить громкость (возможно, включён режим «Не беспокоить»)."));
        }
    }
}
