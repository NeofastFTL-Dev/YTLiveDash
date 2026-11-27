package ftl.emilli.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Insets;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableStringBuilder;
import android.text.style.StyleSpan;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.LinearInterpolator;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The whole stream dashboard on the phone: timer, OBS, boosts, music, YouTube,
 * Ko-fi, settings and the log. Native views talking JSON to the timer server.
 */
public class MainActivity extends Activity {

    private static final long STATE_MS = 2000;

    private static final int BG_CHIP = R.drawable.bg_chip;
    private static final int BG_CHIP_LIVE = R.drawable.bg_chip_live;
    private static final int BG_CHIP_OVER = R.drawable.bg_chip_over;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private ExecutorService net;
    private Api api;
    private String base;
    private boolean inSetup = true;

    // setup screen
    private EditText setupUrl, setupPin;
    private TextView setupStatus;

    // header + tabs
    private TextView statusChip, foot;
    private TextView tabLive, tabMusic, tabYoutube, tabSystem, tabTwitch, tabBrb, tabScenes, tabMixer;
    private LinearLayout panelLive, panelMusic, panelYoutube, panelSystem, panelTwitch, panelBrb, panelScenes, panelMixer;

    // mixer tab: one fader per OBS audio input
    private LinearLayout mixerList;
    private TextView mixerHint;
    private String mixerSig = "";
    private final java.util.LinkedHashMap<String, MixerRow> mixerRows = new java.util.LinkedHashMap<>();

    /** One audio source's row: -60 dB … +6 dB, dragged and debounced. */
    private static final class MixerRow {
        TextView value;
        Button mute;
        SeekBar slider;
        Runnable send;
        int db;
        boolean muted;
        boolean dragging;
    }
    private HorizontalScrollView tabsScroll;

    // scenes tab: text and pictures inside one scene
    private static final int REQ_PICK_PICTURE = 4711;
    private LinearLayout scenePickBox, sceneTextList, sceneImageList, sceneToggleList;
    private TextView scenePickHint;
    private String sceneTarget = "";
    private List<String> sceneNames = new ArrayList<>();
    private JSONArray sceneSourceItems;
    private int sceneCanvasH = 1080;

    // layout tab: the scene as OBS renders it, dragged with a thumb
    private SceneCanvas layoutCanvas;
    private TextView layoutHint, tabLayout;
    private LinearLayout layoutSceneBox, panelLayout;
    private boolean layoutLoading;

    // away timer: a reason plus the clock time the stream is back
    private TextView awayStatus;
    private LinearLayout awayPresets, awayDurs;
    private String awayReason = "at work";
    private JSONObject lastAway;

    // alert preview: the same card the OBS overlay draws, rendered on the phone
    private LinearLayout alertPreview;
    private EditText alertName, alertAmount, alertMessage;

    // live events (SSE) so state and alerts arrive without waiting for a poll
    private volatile boolean eventsOn;
    private volatile HttpURLConnection eventsConn;
    private Thread eventsThread;

    // brb overlay texts
    private LinearLayout brbList, brbPresets;
    private TextView brbStatus;
    private EditText brbInput;
    private String brbSelectedId = "";
    private String brbPreset = "rainbow-wiggle";
    private String brbSig = "";
    private String brbChipSig = "";

    // twitch queue
    private LinearLayout twList;
    private TextView twState, twScene, twError;
    private Button twNext, twAuto, twAdd;
    private EditText twInput;
    private boolean twitchAuto = true;
    private String twitchSig = "";
    private int tab = 0;

    // live
    private TextView tLabel, tClock, tSub, obsInfo, sceneHint;
    private TextView statSub, statKofi, statLike;
    private Button obsStart, obsStop, undoBtn, ytSync;
    private LinearLayout scenesBox, feedBox;
    private TextView feedLabel;
    private HorizontalScrollView scenesScroll;
    private String lastScrolledScene = "";

    // music
    private TextView mixVal, mixHint, npTitle, npMeta, npProgress;
    private Button mixMute;
    private SeekBar mixSlider;

    // youtube / kofi
    private TextView ytMode, ytChannel, ytSubs, ytLikes, ytLast, ytError, ytLatency;
    private TextView kofiState, kofiHits, kofiLast;
    private Button ytSync2, ytUltra, ytAuto;
    private EditText ytTitle, ytDesc, ytChat;
    private Button ytSaveInfo, ytPostChat;
    private TextView ytInfoState;
    private boolean ytInfoLoaded;   // prefill the title/description only once
    private TextView ytLink;
    private Button ytCopy;
    // The permanent live alias follows the channel handle from /api/state.
    private String liveHandle = "EmilliFTL";

    // system
    private EditText startAtInput;
    private TextView sysObs, sysServer, sysUptime, sysRemote;
    private LinearLayout logBox;

    // state
    private JSONObject state;
    private JSONObject nowPlaying;
    private JSONObject health;
    private long offset;
    private boolean fetchBusy;
    private boolean dragging;
    private boolean mixReady, mixMuted;
    private int mixDb;
    private String currentScene = "";
    private String pendingToken;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            renderClock();
            ui.postDelayed(this, 250);
        }
    };

    private int pollTick = 0;

    private final Runnable poller = new Runnable() {
        @Override
        public void run() {
            fetchState();
            // Scenes change from OBS itself, so re-read them every ~16 s.
            if (++pollTick % 8 == 0) refreshScenes();
            // A fader moved on the desktop while the mixer is open: re-read it.
            if (tab == 7 && pollTick % 3 == 0) refreshMixer();
            ui.postDelayed(this, STATE_MS);
        }
    };

    private final Runnable volumeSend = new Runnable() {
        @Override
        public void run() {
            sendVolume();
        }
    };

    /* ------------------------------------------------------------- lifecycle */

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        net = Executors.newSingleThreadExecutor();
        boot();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!inSetup && api != null) {
            startLoops();
            // Back from the lock screen: scenes/BRB may have moved while the
            // app was paused, so re-read them instead of waiting for a tick.
            refreshScenes();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopLoops();
    }

    @Override
    protected void onDestroy() {
        stopLoops();
        if (net != null) net.shutdownNow();
        super.onDestroy();
    }

    private void boot() {
        base = Store.base(this);
        String cookie = Store.cookie(this);

        if (base == null) {
            String baked = getString(R.string.default_url);
            Uri u = Uri.parse(baked);
            if (u.getAuthority() != null) {
                base = u.getScheme() + "://" + u.getAuthority();
                pendingToken = u.getQueryParameter("t");
                Store.save(this, base, null);
                cookie = null;
            }
        }

        if (base == null) {
            showSetup("Enter the address on the streaming PC and the PIN.", "", "");
            return;
        }
        if (cookie == null || cookie.isEmpty()) {
            if (pendingToken != null && !pendingToken.isEmpty()) {
                showSetup("Signing in to " + base + "…", base, "");
                signIn(pendingToken);
            } else {
                showSetup("Enter the PIN from ./remote-url.sh.", base, "");
            }
            return;
        }
        startDashboard(base, cookie);
    }

    /* ------------------------------------------------------------- sign in */

    private void showSetup(String status, String url, String pin) {
        inSetup = true;
        api = null;
        stopLoops();
        setContentView(R.layout.activity_setup);
        applyInsets(findViewById(R.id.root));
        lightSystemBars();

        setupUrl = findViewById(R.id.setupUrl);
        setupPin = findViewById(R.id.setupPin);
        setupStatus = findViewById(R.id.setupStatus);
        Button go = findViewById(R.id.setupGo);

        setupUrl.setText(url);
        setupPin.setText(pin);
        setupStatus.setText(status);

        go.setOnClickListener(v -> {
            String target = Api.normalize(setupUrl.getText().toString());
            String secret = setupPin.getText().toString().trim();
            if (target == null) {
                setupStatus.setText("That address does not look right.");
                return;
            }
            if (secret.isEmpty()) {
                setupStatus.setText("Enter the PIN (or the long token).");
                return;
            }
            base = target;
            showSetup("Signing in to " + target + "…", target, secret);
            signIn(secret);
        });
    }

    private void signIn(final String secret) {
        final String target = base;
        net.execute(() -> {
            String cookie;
            Exception failure = null;
            try {
                cookie = Api.login(target, secret);
            } catch (IOException e) {
                cookie = null;
                failure = e;
            }
            final String got = cookie;
            final Exception err = failure;
            ui.post(() -> {
                if (got != null) {
                    Store.save(MainActivity.this, target, got);
                    pendingToken = null;
                    startDashboard(target, got);
                } else {
                    pendingToken = null;
                    showSetup(
                        err == null
                            ? "Wrong PIN, or the server said no."
                            : "Cannot reach " + target + "\n" + err.getMessage(),
                        target,
                        ""
                    );
                }
            });
        });
    }

    private void sessionLost() {
        stopLoops();
        Store.dropSession(this);
        api = null;
        showSetup("Session expired — sign in again.", base == null ? "" : base, "");
    }

    /* ------------------------------------------------------------- dashboard */

    private void startDashboard(String target, String cookie) {
        api = new Api(target, cookie);
        inSetup = false;
        setContentView(R.layout.activity_main);
        applyInsets(findViewById(R.id.root));
        lightSystemBars();
        bind();
        foot.setText(target.replace("https://", "").replace("http://", ""));
        showTab(0);
        renderAll();
        startLoops();
        refreshScenes();
        refreshAudio();
        refreshHealth();
    }

    private void bind() {
        statusChip = findViewById(R.id.statusChip);
        foot = findViewById(R.id.foot);

        tabLive = findViewById(R.id.tabLive);
        tabMusic = findViewById(R.id.tabMusic);
        tabYoutube = findViewById(R.id.tabYoutube);
        tabSystem = findViewById(R.id.tabSystem);
        panelLive = findViewById(R.id.panelLive);
        panelMusic = findViewById(R.id.panelMusic);
        panelYoutube = findViewById(R.id.panelYoutube);
        panelSystem = findViewById(R.id.panelSystem);
        panelTwitch = findViewById(R.id.panelTwitch);

        tabTwitch = findViewById(R.id.tabTwitch);
        panelBrb = findViewById(R.id.panelBrb);
        tabBrb = findViewById(R.id.tabBrb);
        tabScenes = findViewById(R.id.tabScenes);
        panelScenes = findViewById(R.id.panelScenes);
        tabMixer = findViewById(R.id.tabMixer);
        panelMixer = findViewById(R.id.panelMixer);
        tabLayout = findViewById(R.id.tabLayout);
        panelLayout = findViewById(R.id.panelLayout);
        layoutCanvas = findViewById(R.id.layoutCanvas);
        layoutHint = findViewById(R.id.layoutHint);
        layoutSceneBox = findViewById(R.id.layoutSceneBox);
        mixerList = findViewById(R.id.mixerList);
        mixerHint = findViewById(R.id.mixerHint);
        tabsScroll = findViewById(R.id.tabsScroll);
        scenePickBox = findViewById(R.id.scenePickBox);
        scenePickHint = findViewById(R.id.scenePickHint);
        sceneTextList = findViewById(R.id.sceneTextList);
        sceneImageList = findViewById(R.id.sceneImageList);
        sceneToggleList = findViewById(R.id.sceneToggleList);
        brbList = findViewById(R.id.brbList);
        brbPresets = findViewById(R.id.brbPresets);
        brbStatus = findViewById(R.id.brbStatus);
        brbInput = findViewById(R.id.brbInput);
        twList = findViewById(R.id.twList);
        twState = findViewById(R.id.twState);
        twScene = findViewById(R.id.twScene);
        twError = findViewById(R.id.twError);
        twNext = findViewById(R.id.twNext);
        twAuto = findViewById(R.id.twAuto);
        twAdd = findViewById(R.id.twAdd);
        twInput = findViewById(R.id.twInput);

        tLabel = findViewById(R.id.tLabel);
        tClock = findViewById(R.id.tClock);
        tSub = findViewById(R.id.tSub);
        obsInfo = findViewById(R.id.obsInfo);
        sceneHint = findViewById(R.id.sceneHint);
        statSub = findViewById(R.id.statSub);
        statKofi = findViewById(R.id.statKofi);
        statLike = findViewById(R.id.statLike);
        obsStart = findViewById(R.id.obsStart);
        obsStop = findViewById(R.id.obsStop);
        undoBtn = findViewById(R.id.undoBtn);
        ytSync = findViewById(R.id.ytSync);
        scenesBox = findViewById(R.id.scenes);
        scenesScroll = findViewById(R.id.scenesScroll);
        feedBox = findViewById(R.id.feed);
        feedLabel = findViewById(R.id.feedLabel);
        alertPreview = findViewById(R.id.alertPreview);
        alertName = findViewById(R.id.alertName);
        alertAmount = findViewById(R.id.alertAmount);
        alertMessage = findViewById(R.id.alertMessage);

        mixVal = findViewById(R.id.mixVal);
        mixHint = findViewById(R.id.mixHint);
        npTitle = findViewById(R.id.npTitle);
        npMeta = findViewById(R.id.npMeta);
        npProgress = findViewById(R.id.npProgress);
        mixMute = findViewById(R.id.mixMute);
        mixSlider = findViewById(R.id.mixSlider);

        ytMode = findViewById(R.id.ytMode);
        ytChannel = findViewById(R.id.ytChannel);
        ytSubs = findViewById(R.id.ytSubs);
        ytLikes = findViewById(R.id.ytLikes);
        ytLast = findViewById(R.id.ytLast);
        ytError = findViewById(R.id.ytError);
        ytLatency = findViewById(R.id.ytLatency);
        ytUltra = findViewById(R.id.ytUltra);
        ytAuto = findViewById(R.id.ytAuto);
        ytTitle = findViewById(R.id.ytTitle);
        ytDesc = findViewById(R.id.ytDesc);
        ytChat = findViewById(R.id.ytChat);
        ytSaveInfo = findViewById(R.id.ytSaveInfo);
        ytPostChat = findViewById(R.id.ytPostChat);
        ytInfoState = findViewById(R.id.ytInfoState);
        ytSync2 = findViewById(R.id.ytSync2);
        ytLink = findViewById(R.id.ytLink);
        ytCopy = findViewById(R.id.ytCopy);
        refreshLiveLink();
        kofiState = findViewById(R.id.kofiState);
        kofiHits = findViewById(R.id.kofiHits);
        kofiLast = findViewById(R.id.kofiLast);

        startAtInput = findViewById(R.id.startAtInput);
        sysObs = findViewById(R.id.sysObs);
        sysServer = findViewById(R.id.sysServer);
        sysUptime = findViewById(R.id.sysUptime);
        sysRemote = findViewById(R.id.sysRemote);
        logBox = findViewById(R.id.logBox);

        tabLive.setOnClickListener(v -> showTab(0));
        tabMusic.setOnClickListener(v -> showTab(1));
        tabYoutube.setOnClickListener(v -> showTab(2));
        tabSystem.setOnClickListener(v -> showTab(3));
        tabTwitch.setOnClickListener(v -> showTab(4));

        tabBrb.setOnClickListener(v -> showTab(5));
        tabScenes.setOnClickListener(v -> showTab(6));
        tabMixer.setOnClickListener(v -> showTab(7));
        tabLayout.setOnClickListener(v -> showTab(8));
        bindLayoutCanvas();

        awayStatus = findViewById(R.id.awayStatus);
        awayPresets = findViewById(R.id.awayPresets);
        awayDurs = findViewById(R.id.awayDurs);
        findViewById(R.id.awayUntil).setOnClickListener(v -> pickAwayUntil());
        findViewById(R.id.awayClear).setOnClickListener(v -> setAway(null, 0, 0));
        buildAwayChoices();
        renderAwayStatus(null);
        findViewById(R.id.sceneAddText).setOnClickListener(v -> newSceneText());
        findViewById(R.id.sceneAddImage).setOnClickListener(v -> pickPicture());

        findViewById(R.id.brbSave).setOnClickListener(v -> saveBrb());
        findViewById(R.id.brbNew).setOnClickListener(v -> newBrb());

        twNext.setOnClickListener(v -> post("/api/twitch/next", null, "NEXT STREAMER", null));
        twAuto.setOnClickListener(v -> setTwitchAuto(!twitchAuto));
        twAdd.setOnClickListener(v -> addTwitchStreamer());

        obsStart.setOnClickListener(v -> post("/api/obs/start", null, "OBS: GO LIVE", this::refreshScenes));
        obsStop.setOnClickListener(v -> post("/api/obs/stop", null, "OBS: STREAM ENDED", this::refreshScenes));
        undoBtn.setOnClickListener(v -> post("/api/undo", null, "UNDO", null));

        // Replay an alert here and on the OBS overlay, counting nothing. The
        // phone draws the same card so the look can be checked without OBS.
        findViewById(R.id.replaySub).setOnClickListener(v -> replay("sub"));
        findViewById(R.id.replayKofi).setOnClickListener(v -> replay("kofi"));
        findViewById(R.id.replayLike).setOnClickListener(v -> replay("like"));
        ytSync.setOnClickListener(v -> syncYouTube());
        ytSync2.setOnClickListener(v -> syncYouTube());
        ytUltra.setOnClickListener(v -> confirmSwitchLatency());
        ytAuto.setOnClickListener(v -> toggleAutoUltra());
        ytSaveInfo.setOnClickListener(v -> saveStreamInfo());
        ytPostChat.setOnClickListener(v -> postChat());
        ytLink.setOnClickListener(v -> openLiveLink());
        ytCopy.setOnClickListener(v -> copyLiveLink());

        findViewById(R.id.boostSub).setOnClickListener(v -> post("/api/boost", body("type", "sub"), "SUB +5:00", null));
        findViewById(R.id.boostKofi).setOnClickListener(v -> post("/api/boost", body("type", "kofi"), "KO-FI +30:00", null));
        findViewById(R.id.boostLike).setOnClickListener(v -> post("/api/boost", body("type", "like"), "LIKE +0:30", null));
        findViewById(R.id.settingsBtn).setOnClickListener(v -> showSetup("Sign in again, or change the server address.", base, ""));

        findViewById(R.id.volDown).setOnClickListener(v -> nudgeVolume(-3));
        findViewById(R.id.volUp).setOnClickListener(v -> nudgeVolume(3));
        findViewById(R.id.volZero).setOnClickListener(v -> setVolumeDb(0));

        findViewById(R.id.saveStart).setOnClickListener(v -> saveStartTime());
        findViewById(R.id.startNowBtn).setOnClickListener(v -> post("/api/start", null, "STARTED", null));
        findViewById(R.id.resetBtn).setOnClickListener(v -> confirmReset());

        mixSlider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (!fromUser) return;
                mixDb = progress - 60;
                mixReady = true;
                renderAudio();
                ui.removeCallbacks(volumeSend);
                ui.postDelayed(volumeSend, 180);
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
                dragging = true;
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
                dragging = false;
                ui.removeCallbacks(volumeSend);
                sendVolume();
            }
        });

        mixMute.setOnClickListener(v -> {
            if (!mixReady) return;
            mixMuted = !mixMuted;
            renderAudio();
            JSONObject b = new JSONObject();
            try {
                b.put("muted", mixMuted);
            } catch (JSONException ignored) {
            }
            post("/api/ytpmvs/audio", b, null, this::refreshAudio);
        });
    }

    private void showTab(int index) {
        tab = index;
        if (index != 8) stopLayoutPreview();
        TextView[] tabs = {tabLive, tabMusic, tabYoutube, tabSystem, tabTwitch, tabBrb, tabScenes, tabMixer, tabLayout};
        LinearLayout[] panels = {panelLive, panelMusic, panelYoutube, panelSystem, panelTwitch, panelBrb, panelScenes, panelMixer, panelLayout};
        for (int i = 0; i < tabs.length; i++) {
            if (tabs[i] == null) continue;
            tabs[i].setSelected(i == index);
            panels[i].setVisibility(i == index ? View.VISIBLE : View.GONE);
        }
        revealTab(tabs[index]);
        if (index == 1) {
            refreshAudio();
            refreshNowPlaying();
        } else if (index == 2) {
            renderYoutube();
            renderKofi();
            fetchState();
        } else if (index == 3) {
            refreshHealth();
            renderSystem();
            renderLog();
            if (state != null) startAtInput.setText(state.optString("startAt", ""));
        } else if (index == 4) {
            renderTwitch();
            fetchState();
        } else if (index == 5) {
            renderBrb();
            fetchState();
        } else if (index == 6) {
            if (sceneTarget.isEmpty()) sceneTarget = currentScene;
            renderScenePick();
            refreshSceneSources();
            fetchState();
        } else if (index == 7) {
            refreshMixer();
            fetchState();
        } else if (index == 8) {
            if (sceneTarget.isEmpty()) sceneTarget = currentScene;
            renderLayoutScenes();
            startLayoutPreview();
            fetchState();
        }
    }

    /** Seven tabs no longer fit on a phone, so slide the strip to the chosen one. */
    private void revealTab(View tabView) {
        if (tabsScroll == null || tabView == null) return;
        tabsScroll.post(() -> tabsScroll.smoothScrollTo(Math.max(0, tabView.getLeft() - dp(10)), 0));
    }

    private void startLoops() {
        ui.removeCallbacks(ticker);
        ui.removeCallbacks(poller);
        ui.post(ticker);
        ui.post(poller);
        startEvents();
    }

    private void stopLoops() {
        ui.removeCallbacks(ticker);
        ui.removeCallbacks(poller);
        ui.removeCallbacks(volumeSend);
        stopEvents();
    }

    /* ---------------------------------------------------------- live events */

    /**
     * /api/events carries the state the moment something changes plus every
     * alert. Keeping it open means a sub, a scene switch or a replay lands on
     * the phone right away instead of on the next 2 s poll.
     */
    private void startEvents() {
        if (eventsOn || api == null || inSetup) return;
        eventsOn = true;
        eventsThread = new Thread(this::eventsLoop, "events");
        eventsThread.setDaemon(true);
        eventsThread.start();
    }

    private void stopEvents() {
        eventsOn = false;
        HttpURLConnection c = eventsConn;
        if (c != null) {
            try {
                c.disconnect();
            } catch (Exception ignored) {
            }
        }
        eventsThread = null;
    }

    private void eventsLoop() {
        while (eventsOn) {
            HttpURLConnection c = null;
            try {
                c = api.stream("/api/events");
                eventsConn = c;
                int code = c.getResponseCode();
                if (code == 401) {
                    ui.post(this::sessionLost);
                    return;
                }
                if (code != 200) throw new IOException("HTTP " + code);

                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                String event = "message";
                StringBuilder data = new StringBuilder();
                String line;
                while (eventsOn && (line = reader.readLine()) != null) {
                    if (line.isEmpty()) {
                        dispatchEvent(event, data.toString());
                        event = "message";
                        data.setLength(0);
                    } else if (line.startsWith("event:")) {
                        event = line.substring(6).trim();
                    } else if (line.startsWith("data:")) {
                        if (data.length() > 0) data.append('\n');
                        data.append(line.substring(5).trim());
                    }
                    // ": ping" comment lines keep the socket alive; nothing to do.
                }
            } catch (IOException ignored) {
                // relaunch, tunnel hiccup, phone asleep: reconnect below
            } finally {
                eventsConn = null;
                if (c != null) {
                    try {
                        c.disconnect();
                    } catch (Exception ignored) {
                    }
                }
            }
            if (!eventsOn) break;
            try {
                Thread.sleep(2500);
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    private void dispatchEvent(String event, String data) {
        if (data.isEmpty()) return;
        final JSONObject o;
        try {
            o = new JSONObject(data);
        } catch (JSONException e) {
            return;
        }
        if ("state".equals(event)) {
            ui.post(() -> applyState(o));
        } else if ("message".equals(event)) {
            // A replay this phone just fired is already on screen.
            if ("replay".equals(o.optString("source", ""))) return;
            ui.post(() -> showAlertPreview(o));
        }
    }

    /* -------------------------------------------------------------- polling */

    private void fetchState() {
        if (api == null || fetchBusy) return;
        fetchBusy = true;
        final Api a = api;
        net.execute(() -> {
            try {
                final JSONObject s = a.get("/api/state");
                ui.post(() -> {
                    fetchBusy = false;
                    applyState(s);
                });
            } catch (Api.Unauthorized e) {
                ui.post(() -> {
                    fetchBusy = false;
                    sessionLost();
                });
            } catch (IOException e) {
                ui.post(() -> {
                    fetchBusy = false;
                    offline();
                });
            }
        });
    }

    private void applyState(JSONObject s) {
        if (s == null) return;
        state = s;
        offset = s.optLong("serverNow", System.currentTimeMillis()) - System.currentTimeMillis();
        renderAll();
        // The server caches OBS's program scene from its event stream and puts it
        // in /api/state, so scene switches made on the desktop show up here on the
        // normal poll instead of waiting for a fresh scene list.
        JSONObject integ = s.optJSONObject("integrations");
        JSONObject obsState = integ == null ? null : integ.optJSONObject("obs");
        if (obsState != null && !obsState.isNull("scene")) {
            applyCurrentScene(obsState.optString("scene", ""));
        }
        renderTwitch();
        renderBrb();
    }

    /** Re-mark the chips in place when the program scene changed somewhere else. */
    private void applyCurrentScene(String name) {
        if (scenesBox == null || name == null || name.isEmpty() || name.equals(currentScene)) return;
        currentScene = name;
        View selected = null;
        boolean present = false;
        for (int i = 0; i < scenesBox.getChildCount(); i++) {
            View v = scenesBox.getChildAt(i);
            if (!(v instanceof Button)) continue;
            boolean isCurrent = name.contentEquals(((Button) v).getText());
            v.setSelected(isCurrent);
            if (isCurrent) {
                selected = v;
                present = true;
            }
        }
        sceneHint.setText("program: " + name);
        if (!present) {
            // A scene the chips have never seen (added in OBS since the last list).
            refreshScenes();
            return;
        }
        revealChip(selected);
    }

    /** The row scrolls sideways; keep the highlighted chip on screen. */
    private void revealChip(View chip) {
        if (chip == null || scenesScroll == null) return;
        if (currentScene.equals(lastScrolledScene)) return;
        lastScrolledScene = currentScene;
        scenesScroll.post(() -> scenesScroll.smoothScrollTo(Math.max(0, chip.getLeft() - dp(8)), 0));
    }

    private void offline() {
        chip("OFFLINE", BG_CHIP_OVER, 0xFFFFD9C8);
    }

    private void refreshScenes() {
        if (api == null) return;
        final Api a = api;
        net.execute(() -> {
            try {
                final JSONObject r = a.get("/api/obs/scenes");
                ui.post(() -> renderScenes(r));
            } catch (Api.Unauthorized e) {
                ui.post(this::sessionLost);
            } catch (IOException ignored) {
            }
        });
    }

    private void refreshAudio() {
        if (api == null || dragging) return;
        final Api a = api;
        net.execute(() -> {
            try {
                final JSONObject r = a.get("/api/ytpmvs/audio");
                ui.post(() -> {
                    if (r.optBoolean("ok")) {
                        mixReady = true;
                        mixMuted = r.optBoolean("muted");
                        mixDb = (int) Math.round(r.optDouble("volumeDb", 0));
                    } else {
                        mixReady = false;
                    }
                    renderAudio();
                });
            } catch (Api.Unauthorized e) {
                ui.post(this::sessionLost);
            } catch (IOException ignored) {
            }
        });
    }

    private void refreshNowPlaying() {
        if (api == null) return;
        final Api a = api;
        net.execute(() -> {
            try {
                final JSONObject r = a.get("/api/nowplaying");
                ui.post(() -> {
                    nowPlaying = r;
                    renderNowPlaying();
                });
            } catch (IOException ignored) {
            }
        });
    }

    private void refreshHealth() {
        if (api == null) return;
        final Api a = api;
        net.execute(() -> {
            try {
                final JSONObject r = a.get("/api/health");
                ui.post(() -> {
                    health = r;
                    renderSystem();
                });
            } catch (IOException ignored) {
            }
        });
    }

    /* --------------------------------------------------------------- render */

    private void renderAll() {
        if (state == null || tClock == null) return;
        renderClock();

        JSONObject counts = state.optJSONObject("counts");
        statSub.setText(String.valueOf(counts == null ? 0 : counts.optInt("sub")));
        statKofi.setText(String.valueOf(counts == null ? 0 : counts.optInt("kofi")));
        statLike.setText(String.valueOf(counts == null ? 0 : counts.optInt("like")));

        JSONArray log = state.optJSONArray("log");
        undoBtn.setEnabled(log != null && log.length() > 0);

        JSONObject integ = state.optJSONObject("integrations");
        JSONObject ob = integ == null ? null : integ.optJSONObject("obs");
        renderAwayStatus(integ == null ? null : integ.optJSONObject("away"));
        boolean enabled = ob != null && ob.optBoolean("enabled");
        boolean connected = ob != null && ob.optBoolean("connected");
        boolean streaming = ob != null && ob.optBoolean("streaming");
        boolean held = ob != null && ob.optBoolean("held");

        if (!enabled) {
            text(obsInfo, "OBS control is off in config.json", R.color.dim);
        } else if (!connected) {
            String err = ob == null ? "" : ob.optString("error", "");
            text(obsInfo, err.isEmpty() ? "OBS not connected" : err, R.color.like);
        } else if (streaming) {
            text(obsInfo, "LIVE · auto-stops at zero", R.color.ok);
        } else if (held) {
            text(obsInfo, "held after manual END · press GO LIVE", R.color.dim);
        } else {
            text(obsInfo, "connected · not streaming", R.color.dim);
        }
        obsStart.setEnabled(connected);
        obsStop.setEnabled(connected);

        renderFeed();
        renderYoutube();
        renderKofi();
        renderSystem();
        renderLog();
        if (startAtInput != null && startAtInput.getText().length() == 0) {
            startAtInput.setText(state.optString("startAt", ""));
        }
    }

    private void renderClock() {
        if (state == null || tClock == null) return;
        long now = System.currentTimeMillis() + offset;
        long bank = state.optLong("baseMs") + state.optLong("addedMs");
        long startedAt = state.isNull("startedAt") ? 0 : state.optLong("startedAt", 0);

        if (startedAt == 0) {
            long start = parseStart(state.optString("startAt", ""));
            long left = start + bank - now;
            tLabel.setText("STREAM ENDS IN");
            tClock.setText(clockText(left));
            tClock.setTextColor(left <= 0 ? color(R.color.yt) : 0xFFFFF0F4);
            tSub.setText(styled("goes live ", dayLabel(start) + hhmm(start), ""));
            chip("PRE-STREAM", BG_CHIP, color(R.color.dim));
        } else {
            long left = bank - (now - startedAt);
            long end = startedAt + bank;
            tLabel.setText(left <= 0 ? "TIME'S UP" : "TIME LEFT ON STREAM");
            tClock.setText(clockText(left));
            tClock.setTextColor(left <= 0 ? color(R.color.like) : 0xFFFFF0F4);
            tSub.setText(styled("ends ", dayLabel(end) + hhmm(end), " · " + shortDur(bank) + " bank"));
            if (left <= 0) chip("OFF AIR", BG_CHIP_OVER, 0xFFFFD9C8);
            else chip("LIVE", BG_CHIP_LIVE, 0xFFFFD8E1);
        }
    }

    private void renderScenes(JSONObject r) {
        if (scenesBox == null) return;
        scenesBox.removeAllViews();

        if (r == null || !r.optBoolean("ok")) {
            scenesBox.addView(label(r == null ? "scenes unavailable" : r.optString("error", "scenes unavailable")));
            sceneHint.setText("");
            return;
        }
        currentScene = r.isNull("current") ? "" : r.optString("current", "");
        JSONArray scenes = r.optJSONArray("scenes");
        List<String> names = new ArrayList<>();
        if (scenes != null) {
            for (int i = 0; i < scenes.length(); i++) {
                String n = scenes.optString(i, "");
                if (!n.isEmpty() && !names.contains(n)) names.add(n);
            }
        }
        // Belt and braces: the server guarantees it, but never show a program
        // scene without a chip of its own to highlight.
        if (!currentScene.isEmpty() && !names.contains(currentScene)) names.add(currentScene);
        if (names.isEmpty()) {
            scenesBox.addView(label("no scenes"));
            sceneHint.setText("");
            return;
        }
        View selectedChip = null;
        for (int i = 0; i < names.size(); i++) {
            final String name = names.get(i);
            Button chip = new Button(this);
            chip.setText(name);
            chip.setAllCaps(false);
            chip.setTypeface(Typeface.MONOSPACE);
            chip.setTextSize(11.5f);
            chip.setBackgroundResource(R.drawable.bg_btn_scene);
            chip.setTextColor(getColorStateList(R.color.scene_text));
            chip.setSelected(name.equals(currentScene));
            chip.setMinHeight(0);
            chip.setMinimumHeight(0);
            chip.setMinWidth(0);
            chip.setMinimumWidth(0);
            chip.setPadding(dp(15), dp(10), dp(15), dp(10));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            );
            lp.rightMargin = dp(8);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> pickScene(name));
            scenesBox.addView(chip);
            if (name.equals(currentScene)) selectedChip = chip;
        }
        sceneHint.setText(currentScene.isEmpty() ? "" : "program: " + currentScene);
        sceneNames = names;
        renderScenePick();
        revealChip(selectedChip);
    }

    /* --------------------------------------------------------------- scenes */

    /**
     * Chips for the Scenes tab. Tapping picks the scene to edit; the ▶ marker
     * shows which one is on air, and nothing here switches the program scene.
     */
    private void renderScenePick() {
        if (tab == 8) renderLayoutScenes();
        if (scenePickBox == null) return;
        if (sceneTarget.isEmpty() || (!sceneNames.isEmpty() && !sceneNames.contains(sceneTarget))) {
            sceneTarget = currentScene.isEmpty()
                ? (sceneNames.isEmpty() ? "" : sceneNames.get(0))
                : currentScene;
        }
        scenePickBox.removeAllViews();
        for (int i = 0; i < sceneNames.size(); i++) {
            final String name = sceneNames.get(i);
            Button chip = smallButton(
                (name.equals(currentScene) ? "▶ " : "") + name,
                R.drawable.bg_btn_scene,
                getColorStateList(R.color.scene_text),
                11.5f
            );
            chip.setSelected(name.equals(sceneTarget));
            chip.setPadding(dp(14), dp(10), dp(14), dp(10));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            );
            lp.rightMargin = dp(8);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                sceneTarget = name;
                renderScenePick();
                refreshSceneSources();
            });
            scenePickBox.addView(chip);
        }
        if (scenePickHint != null && sceneNames.isEmpty()) scenePickHint.setText("no scenes yet (OBS offline?)");
    }

    /** Show or hide one source in the scene being edited, without switching scenes. */
    private void setSourceVisible(int sceneItemId, boolean visible) {
        if (api == null || sceneTarget.isEmpty()) return;
        JSONObject body = new JSONObject();
        try {
            body.put("scene", sceneTarget);
            body.put("sceneItemId", sceneItemId);
            body.put("visible", visible);
        } catch (JSONException ignored) {
        }
        post("/api/obs/source/visible", body, visible ? "source shown" : "source hidden",
            this::refreshSceneSources);
    }

    /**
     * Move one source up or down the scene's layer stack. OBS numbers scene
     * items from the back (0) to the front, so +1 is "in front" and -1 is
     * "behind"; the server clamps at either end.
     */
    private void moveSource(int sceneItemId, int delta) {
        if (api == null || sceneTarget.isEmpty()) return;
        JSONObject body = new JSONObject();
        try {
            body.put("scene", sceneTarget);
            body.put("sceneItemId", sceneItemId);
            body.put("delta", delta);
        } catch (JSONException ignored) {
        }
        post("/api/obs/source/order", body, delta > 0 ? "moved to front" : "moved to back",
            this::refreshSceneSources);
    }

    /** Base body for one source's canvas move. */
    private JSONObject positionBody(int sceneItemId) {
        JSONObject body = new JSONObject();
        try {
            body.put("scene", sceneTarget);
            body.put("sceneItemId", sceneItemId);
        } catch (JSONException ignored) {
        }
        return body;
    }

    /** Send one position change and keep the open dialog's readout in step. */
    private void nudgeSource(JSONObject body, final TextView readout) {
        if (api == null || sceneTarget.isEmpty()) return;
        final Api a = api;
        net.execute(() -> {
            try {
                final JSONObject r = a.post("/api/obs/source/position", body);
                ui.post(() -> {
                    if (!r.optBoolean("ok", false)) {
                        toast(r.optString("error", "move failed"));
                        return;
                    }
                    readout.setText("y " + r.optInt("y", 0) + " / " + r.optInt("canvasH", 1080)
                        + "  ·  step " + r.optInt("step", 0) + "px");
                    refreshSceneSources();
                });
            } catch (Api.Unauthorized e) {
                ui.post(this::sessionLost);
            } catch (IOException e) {
                ui.post(() -> toast("no connection"));
            }
        });
    }

    /**
     * Move one source up or down on the picture itself (not the layer stack):
     * nudge in 5% steps, or jump straight to the top, middle or bottom.
     */
    private void sourcePositionDialog(final int sceneItemId, String name, int startY, int canvasH) {
        LinearLayout box = dialogBox();
        final TextView readout = label("y " + startY + " / " + canvasH + "  ·  step " + Math.max(1, Math.round(canvasH * 0.05)) + "px");
        readout.setTextSize(12f);
        readout.setTextColor(color(R.color.txt));
        box.addView(readout);

        LinearLayout nudge = new LinearLayout(this);
        nudge.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nlp.topMargin = dp(8);
        nudge.setLayoutParams(nlp);

        Button up = smallButton("▲ UP", R.drawable.bg_btn, color(R.color.txt), 12f);
        up.setLayoutParams(new LinearLayout.LayoutParams(0, dp(46), 1f));
        up.setOnClickListener(v -> {
            JSONObject b = positionBody(sceneItemId);
            try {
                b.put("steps", -1);
            } catch (JSONException ignored) {
            }
            nudgeSource(b, readout);
        });
        nudge.addView(up);

        Button down = smallButton("▼ DOWN", R.drawable.bg_btn, color(R.color.txt), 12f);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(0, dp(46), 1f);
        dlp.leftMargin = dp(6);
        down.setLayoutParams(dlp);
        down.setOnClickListener(v -> {
            JSONObject b = positionBody(sceneItemId);
            try {
                b.put("steps", 1);
            } catch (JSONException ignored) {
            }
            nudgeSource(b, readout);
        });
        nudge.addView(down);
        box.addView(nudge);

        LinearLayout jumps = new LinearLayout(this);
        jumps.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams jlp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        jlp.topMargin = dp(6);
        jumps.setLayoutParams(jlp);
        String[] labels = {"TOP", "MIDDLE", "BOTTOM"};
        String[] values = {"top", "middle", "bottom"};
        for (int i = 0; i < labels.length; i++) {
            final String to = values[i];
            Button b = smallButton(labels[i], R.drawable.bg_btn_scene, color(R.color.txt), 11f);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(44), 1f);
            if (i > 0) lp.leftMargin = dp(6);
            b.setLayoutParams(lp);
            b.setOnClickListener(v -> {
                JSONObject body = positionBody(sceneItemId);
                try {
                    body.put("to", to);
                } catch (JSONException ignored) {
                }
                nudgeSource(body, readout);
            });
            jumps.addView(b);
        }
        box.addView(jumps);

        new AlertDialog.Builder(this)
            .setTitle(name)
            .setView(box)
            .setNegativeButton("CLOSE", null)
            .show();
    }

    /* ------------------------------------------------------------ layout tab */

    /**
     * The scene render, the source boxes and the drag itself. OBS is the only
     * source of truth, so the picture is re-rendered every few seconds while
     * this tab is open; a drag in progress holds the refresh off so the box
     * under the thumb never jumps back.
     */
    private final Runnable layoutTick = new Runnable() {
        public void run() {
            if (tab != 8) return;
            refreshLayoutPreview();
            ui.postDelayed(this, 3000);
        }
    };

    private void startLayoutPreview() {
        ui.removeCallbacks(layoutTick);
        ui.post(layoutTick);
    }

    private void stopLayoutPreview() {
        ui.removeCallbacks(layoutTick);
    }

    private void renderLayoutScenes() {
        if (layoutSceneBox == null) return;
        layoutSceneBox.removeAllViews();
        for (int i = 0; i < sceneNames.size(); i++) {
            final String name = sceneNames.get(i);
            boolean here = name.equals(sceneTarget);
            Button chip = smallButton(here ? "▶ " + name : name,
                here ? R.drawable.bg_btn_go : R.drawable.bg_btn_scene,
                color(here ? R.color.txt : R.color.faint), 11f);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(34));
            if (i > 0) lp.leftMargin = dp(6);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                sceneTarget = name;
                renderLayoutScenes();
                refreshLayoutPreview();
            });
            layoutSceneBox.addView(chip);
        }
        if (sceneNames.isEmpty()) layoutSceneBox.addView(label("no scenes yet (OBS offline?)"));
    }

    private void bindLayoutCanvas() {
        if (layoutCanvas == null) return;
        layoutCanvas.setListener(new SceneCanvas.Listener() {
            public void onPick(String name, int left, int top) {
                layoutHint.setText(name + "  ·  " + left + "," + top + "  ·  let go to place it");
            }

            public void onDrop(int sceneItemId, String name, int left, int top) {
                if (api == null) return;
                final Api a = api;
                final JSONObject body = positionBody(sceneItemId);
                try {
                    body.put("left", left);
                    body.put("top", top);
                } catch (JSONException ignored) {
                }
                net.execute(() -> {
                    try {
                        final JSONObject r = a.post("/api/obs/source/position", body);
                        ui.post(() -> {
                            if (!r.optBoolean("ok", false)) {
                                toast(r.optString("error", "move failed"));
                                return;
                            }
                            layoutHint.setText(name + "  ·  " + r.optInt("left", left) + ","
                                + r.optInt("top", top) + "  ·  moved in OBS");
                            refreshSceneSources();
                        });
                    } catch (Api.Unauthorized e) {
                        ui.post(() -> sessionLost());
                    } catch (IOException e) {
                        ui.post(() -> toast("no connection"));
                    }
                });
            }
        });
    }

    private void refreshLayoutPreview() {
        if (api == null || layoutCanvas == null) return;
        if (sceneTarget.isEmpty()) sceneTarget = currentScene;
        if (sceneTarget.isEmpty()) {
            layoutHint.setText("no scene yet — pick one above");
            return;
        }
        if (layoutLoading || layoutCanvas.isDragging()) return;
        layoutLoading = true;
        final Api a = api;
        final String scene = sceneTarget;
        net.execute(() -> {
            byte[] jpeg = null;
            JSONObject sources = null;
            String error = null;
            try {
                jpeg = a.bytes("/api/obs/scene/screenshot?scene=" + Uri.encode(scene) + "&width=960");
                sources = a.get("/api/obs/sources?scene=" + Uri.encode(scene));
            } catch (Api.Unauthorized e) {
                ui.post(() -> {
                    layoutLoading = false;
                    sessionLost();
                });
                return;
            } catch (IOException e) {
                error = e.getMessage() == null ? "no connection" : e.getMessage();
            }
            final Bitmap bmp = jpeg == null ? null : BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
            final JSONObject r = sources;
            final String err = error;
            ui.post(() -> {
                layoutLoading = false;
                if (tab != 8 || !scene.equals(sceneTarget)) {
                    if (bmp != null) bmp.recycle();
                    return;
                }
                if (bmp == null) {
                    layoutCanvas.setNote(err != null ? err : "OBS sent no picture");
                    layoutHint.setText("no picture — is OBS open and this scene still there?");
                    return;
                }
                layoutCanvas.setFrame(bmp);
                if (r != null && r.optBoolean("ok", false)) {
                    JSONObject canvas = r.optJSONObject("canvas");
                    layoutCanvas.setSources(r.optJSONArray("items"),
                        canvas == null ? 1920 : canvas.optInt("width", 1920),
                        canvas == null ? 1080 : canvas.optInt("height", 1080));
                }
                layoutHint.setText("drag a box to move that source · " + scene);
            });
        });
    }

    private void refreshSceneSources() {
        if (api == null || sceneTarget.isEmpty()) return;
        final Api a = api;
        final String scene = sceneTarget;
        net.execute(() -> {
            try {
                final JSONObject r = a.get("/api/obs/sources?scene=" + Uri.encode(scene));
                ui.post(() -> {
                    if (!scene.equals(sceneTarget)) return;
                    sceneSourceItems = r.optJSONArray("items");
                    JSONObject canvas = r.optJSONObject("canvas");
                    sceneCanvasH = canvas == null ? 1080 : canvas.optInt("height", 1080);
                    renderSceneSources();
                });
            } catch (Api.Unauthorized e) {
                ui.post(this::sessionLost);
            } catch (IOException e) {
                ui.post(() -> {
                    sceneSourceItems = new JSONArray();
                    renderSceneSources();
                    if (scenePickHint != null) scenePickHint.setText("could not read \"" + scene + "\" — OBS offline?");
                });
            }
        });
    }

    private void renderSceneSources() {
        if (sceneTextList == null) return;
        sceneTextList.removeAllViews();
        sceneImageList.removeAllViews();
        int texts = 0;
        int pictures = 0;

        for (int i = 0; sceneSourceItems != null && i < sceneSourceItems.length(); i++) {
            JSONObject item = sceneSourceItems.optJSONObject(i);
            if (item == null) continue;
            String type = item.optString("type", "other");
            String name = item.optString("name", "");

            if ("text".equals(type)) {
                final String input = name;
                final String value = item.optString("text", "");
                Button line = smallButton(
                    value.isEmpty() ? "(empty)" : value,
                    R.drawable.bg_btn_scene,
                    getColorStateList(R.color.scene_text),
                    12f
                );
                line.setSingleLine(true);
                line.setEllipsize(android.text.TextUtils.TruncateAt.END);
                line.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(44));
                lp.topMargin = dp(texts == 0 ? 0 : 6);
                line.setLayoutParams(lp);
                line.setOnClickListener(v -> editSceneText(input, value));
                sceneTextList.addView(line);
                texts++;
            } else if ("image".equals(type) || "gif".equals(type)) {
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setPadding(0, dp(5), 0, dp(5));
                TextView tag = label("gif".equals(type) ? "GIF" : "PNG");
                tag.setTextColor(color("gif".equals(type) ? R.color.yt : R.color.faint));
                row.addView(tag, new LinearLayout.LayoutParams(dp(44), LinearLayout.LayoutParams.WRAP_CONTENT));
                row.addView(label(name));
                sceneImageList.addView(row);
                pictures++;
            }
        }

        if (texts == 0) sceneTextList.addView(label("no text sources here — tap NEW TEXT"));        if (pictures == 0) sceneImageList.addView(label("no png or gif here — tap ADD PNG / GIF"));
        if (sceneToggleList != null) {
            sceneToggleList.removeAllViews();
            int toggles = 0;
            // Front-first, like OBS's own list: the array arrives back-to-front.
            final int total = sceneSourceItems == null ? 0 : sceneSourceItems.length();
            for (int i = total - 1; i >= 0; i--) {
                JSONObject item = sceneSourceItems.optJSONObject(i);
                if (item == null) continue;
                String name = item.optString("name", "");
                final int id = item.optInt("id", -1);
                if (name.isEmpty() || id <= 0) continue;
                final boolean on = item.optBoolean("enabled", true);
                final int index = item.optInt("index", i);

                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(44));
                if (toggles > 0) rlp.topMargin = dp(6);
                row.setLayoutParams(rlp);

                final int itemY = item.optInt("y", 0);
                final int canvasH = sceneCanvasH > 0 ? sceneCanvasH : 1080;
                TextView nm = label(name + "  ⇕");
                nm.setTextSize(11.5f);
                nm.setTextColor(color(on ? R.color.txt : R.color.faint));
                nm.setSingleLine(true);
                nm.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
                nm.setOnClickListener(v -> sourcePositionDialog(id, name, itemY, canvasH));
                row.addView(nm, new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

                // ▲ toward the front of the scene, ▼ toward the back.
                final boolean canUp = index < total - 1;
                final boolean canDown = index > 0;
                Button up = smallButton("▲", R.drawable.bg_btn_scene,
                    color(canUp ? R.color.txt : R.color.faint), 11f);
                up.setPadding(0, 0, 0, 0);
                up.setEnabled(canUp);
                up.setAlpha(canUp ? 1f : 0.3f);
                up.setOnClickListener(v -> moveSource(id, 1));
                LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(dp(34), dp(34));
                ulp.rightMargin = dp(4);
                row.addView(up, ulp);

                Button down = smallButton("▼", R.drawable.bg_btn_scene,
                    color(canDown ? R.color.txt : R.color.faint), 11f);
                down.setPadding(0, 0, 0, 0);
                down.setEnabled(canDown);
                down.setAlpha(canDown ? 1f : 0.3f);
                down.setOnClickListener(v -> moveSource(id, -1));
                LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(34), dp(34));
                dlp.rightMargin = dp(4);
                row.addView(down, dlp);

                Button pill = smallButton(on ? "ON" : "OFF", R.drawable.bg_btn_scene,
                    color(on ? R.color.ok : R.color.faint), 10f);
                pill.setPadding(dp(16), 0, dp(16), 0);
                pill.setOnClickListener(v -> setSourceVisible(id, !on));
                row.addView(pill, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, dp(34)));

                sceneToggleList.addView(row);
                toggles++;
            }
            if (toggles == 0) {
                sceneToggleList.addView(label("no sources in this scene (OBS offline?)"));
            }
        }

        if (scenePickHint != null) {
            scenePickHint.setText(sceneTarget.isEmpty()
                ? "tap a scene above"
                : "editing \"" + sceneTarget + "\" · on air: " + (currentScene.isEmpty() ? "?" : currentScene));
        }
    }

    private void newSceneText() {
        if (sceneTarget.isEmpty()) {
            toast("pick a scene first");
            return;
        }
        LinearLayout box = dialogBox();
        EditText name = inputField("source name (optional)", "Text");
        EditText value = inputField("the words on stream", "");
        value.setSingleLine(false);
        value.setMinLines(2);
        box.addView(name);
        box.addView(value);
        new AlertDialog.Builder(this)
            .setTitle("New text in " + sceneTarget)
            .setView(box)
            .setNegativeButton("CANCEL", null)
            .setPositiveButton("ADD", (d, w) -> {
                JSONObject body = new JSONObject();
                try {
                    body.put("scene", sceneTarget);
                    body.put("name", name.getText().toString().trim());
                    body.put("text", value.getText().toString());
                } catch (JSONException ignored) {
                }
                post("/api/obs/text", body, "TEXT ADDED", this::refreshSceneSources);
            })
            .show();
    }

    private void editSceneText(final String input, String current) {
        if (input == null || input.isEmpty()) return;
        LinearLayout box = dialogBox();
        EditText value = inputField("text", current);
        value.setSingleLine(false);
        value.setMinLines(3);
        box.addView(value);
        new AlertDialog.Builder(this)
            .setTitle(input)
            .setView(box)
            .setNegativeButton("CANCEL", null)
            .setPositiveButton("SAVE", (d, w) -> {
                JSONObject body = new JSONObject();
                try {
                    body.put("scene", sceneTarget);
                    body.put("input", input);
                    body.put("text", value.getText().toString());
                } catch (JSONException ignored) {
                }
                post("/api/obs/text", body, "TEXT SAVED", this::refreshSceneSources);
            })
            .show();
    }

    /* -------------------------------------------------------------- mixer */

    private void refreshMixer() {
        if (api == null) return;
        final Api a = api;
        net.execute(() -> {
            try {
                final JSONObject r = a.get("/api/obs/audio");
                ui.post(() -> {
                    if (!r.optBoolean("ok")) {
                        if (mixerHint != null) mixerHint.setText(r.optString("error", "mixer unavailable"));
                        return;
                    }
                    renderMixer(r.optJSONArray("inputs"));
                });
            } catch (Api.Unauthorized e) {
                ui.post(this::sessionLost);
            } catch (IOException ignored) {
                ui.post(() -> {
                    if (mixerHint != null) mixerHint.setText("could not read the mixer — OBS offline?");
                });
            }
        });
    }

    private void renderMixer(JSONArray inputs) {
        if (mixerList == null) return;
        JSONArray list = inputs == null ? new JSONArray() : inputs;
        List<String> names = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            String name = o == null ? "" : o.optString("name", "");
            if (!name.isEmpty()) names.add(name);
        }

        if (!names.toString().equals(mixerSig)) {
            mixerSig = names.toString();
            mixerRows.clear();
            mixerList.removeAllViews();
            if (names.isEmpty()) mixerList.addView(label("no audio sources in OBS"));
            for (int i = 0; i < names.size(); i++) addMixerRow(names.get(i), i == 0);
        }

        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o == null) continue;
            MixerRow row = mixerRows.get(o.optString("name", ""));
            if (row == null) continue;
            row.muted = o.optBoolean("muted");
            row.db = (int) Math.round(o.optDouble("volumeDb", 0));
            renderMixerRow(row);
        }

        if (mixerHint != null) {
            mixerHint.setText(names.isEmpty()
                ? "no audio sources — is OBS connected?"
                : names.size() + " sources · sliders are the OBS input volumes");
        }
    }

    private void addMixerRow(final String name, boolean first) {
        final MixerRow row = new MixerRow();

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        blp.topMargin = dp(first ? 0 : 14);
        box.setLayoutParams(blp);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(android.view.Gravity.CENTER_VERTICAL);

        TextView title = label(name);
        title.setTextColor(0xFFD7D7E0);
        title.setTextSize(11.5f);
        head.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        row.value = label("");
        head.addView(row.value);

        row.mute = smallButton("MUTE", R.drawable.bg_btn, color(R.color.txt), 10f);
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(dp(74), dp(36));
        mlp.leftMargin = dp(8);
        row.mute.setLayoutParams(mlp);
        row.mute.setOnClickListener(v -> toggleMixerMute(name));
        head.addView(row.mute);
        box.addView(head);

        row.slider = new SeekBar(this);
        row.slider.setMax(66); // -60 dB … +6 dB
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(2);
        row.slider.setLayoutParams(slp);
        row.slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (!fromUser) return;
                MixerRow r = mixerRows.get(name);
                if (r == null) return;
                r.db = progress - 60;
                r.dragging = true;
                renderMixerRow(r);
                ui.removeCallbacks(r.send);
                ui.postDelayed(r.send, 180);
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
                MixerRow r = mixerRows.get(name);
                if (r != null) r.dragging = true;
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
                MixerRow r = mixerRows.get(name);
                if (r == null) return;
                r.dragging = false;
                ui.removeCallbacks(r.send);
                sendMixerVolume(name);
            }
        });
        box.addView(row.slider);

        row.send = () -> sendMixerVolume(name);
        mixerRows.put(name, row);
        mixerList.addView(box);
    }

    private void renderMixerRow(MixerRow row) {
        if (row == null) return;
        String value;
        if (row.muted) value = "MUTED";
        else if (row.db <= -60) value = "−∞ dB";
        else value = (row.db > 0 ? "+" : "") + row.db + " dB";
        row.value.setText(value);
        row.value.setTextColor(color(row.muted ? R.color.like : R.color.dim));
        row.mute.setText(row.muted ? "UNMUTE" : "MUTE");
        row.mute.setBackgroundResource(row.muted ? R.drawable.bg_btn_stop : R.drawable.bg_btn);
        row.mute.setTextColor(row.muted ? 0xFFFFD8E1 : color(R.color.txt));
        if (!row.dragging) row.slider.setProgress(Math.max(0, Math.min(66, row.db + 60)));
    }

    private void sendMixerVolume(final String name) {
        final Api a = api;
        final MixerRow row = mixerRows.get(name);
        if (a == null || row == null) return;
        final JSONObject body = new JSONObject();
        try {
            body.put("input", name);
            body.put("volumeDb", row.db);
        } catch (JSONException ignored) {
        }
        net.execute(() -> {
            try {
                final JSONObject r = a.post("/api/obs/volume", body);
                if (!r.optBoolean("ok")) {
                    final String error = r.optString("error", "failed");
                    ui.post(() -> toast(name + ": " + error));
                }
            } catch (Api.Unauthorized e) {
                ui.post(this::sessionLost);
            } catch (IOException ignored) {
            }
        });
    }

    private void toggleMixerMute(final String name) {
        MixerRow row = mixerRows.get(name);
        if (row == null || api == null) return;
        JSONObject body = new JSONObject();
        try {
            body.put("input", name);
            body.put("muted", !row.muted);
        } catch (JSONException ignored) {
        }
        post("/api/obs/mute", body, null, this::refreshMixer);
    }

    /* ---------------------------------------------------- pictures in a scene */

    private void pickPicture() {
        if (sceneTarget.isEmpty()) {
            toast("pick a scene first");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        try {
            startActivityForResult(intent, REQ_PICK_PICTURE);
        } catch (RuntimeException e) {
            toast("no gallery app answered");
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != REQ_PICK_PICTURE || result != RESULT_OK || data == null) return;
        Uri uri = data.getData();
        if (uri != null) uploadPicture(uri);
    }

    /** Reads the picked picture off the UI thread and posts it to the server. */
    private void uploadPicture(final Uri uri) {
        final Api a = api;
        if (a == null) return;
        final String scene = sceneTarget;
        final String type = getContentResolver().getType(uri);
        toast("adding picture to " + scene + "…");
        net.execute(() -> {
            boolean ok = false;
            String message;
            try {
                byte[] bytes = readAll(uri);
                if (bytes.length > 8 * 1024 * 1024) throw new IOException("picture too big (max 8 MB)");
                JSONObject body = new JSONObject();
                body.put("scene", scene);
                body.put("name", pictureName(uri));
                body.put("file", pictureFile(uri, type));
                body.put("mime", type == null ? "" : type);
                body.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                JSONObject r = a.post("/api/obs/media", body);
                ok = r.optBoolean("ok");
                message = ok ? "ADDED TO " + scene : r.optString("error", "failed");
            } catch (Api.Unauthorized e) {
                ui.post(this::sessionLost);
                return;
            } catch (Exception e) {
                message = e.getMessage() == null ? "upload failed" : e.getMessage();
            }
            final boolean added = ok;
            final String shown = message;
            ui.post(() -> {
                toast(shown);
                if (added) refreshSceneSources();
            });
        });
    }

    private byte[] readAll(Uri uri) throws IOException {
        InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("cannot open that picture");
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) out.write(chunk, 0, n);
            return out.toByteArray();
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
            }
        }
    }

    private String pictureName(Uri uri) {
        String last = uri.getLastPathSegment();
        String name = last == null ? "" : last.substring(last.lastIndexOf('/') + 1);
        int dot = name.lastIndexOf('.');
        if (dot > 0) name = name.substring(0, dot);
        return name.isEmpty() ? "picture" : name;
    }

    private String pictureFile(Uri uri, String type) {
        String last = uri.getLastPathSegment();
        String name = last == null ? "" : last.substring(last.lastIndexOf('/') + 1);
        if (name.matches("(?i).+\\.(png|gif|jpg|jpeg|webp)$")) return name;
        String ext = "png";
        if ("image/gif".equals(type)) ext = "gif";
        else if ("image/jpeg".equals(type)) ext = "jpg";
        else if ("image/webp".equals(type)) ext = "webp";
        String stem = name.isEmpty() ? "picture" : name.replaceAll("[^A-Za-z0-9._-]", "-");
        return stem + "." + ext;
    }

    private LinearLayout dialogBox() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(4), dp(18), dp(4));
        return box;
    }

    private EditText inputField(String hint, String value) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setText(value);
        field.setTypeface(Typeface.MONOSPACE);
        field.setTextSize(13f);
        field.setTextColor(color(R.color.txt));
        field.setHintTextColor(color(R.color.faint));
        field.setBackgroundResource(R.drawable.bg_input);
        field.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lp.topMargin = dp(8);
        field.setLayoutParams(lp);
        return field;
    }

    /* --------------------------------------------------------------- twitch */

    /* ------------------------------------------------------------ away timer */

    private static final String[] AWAY_REASONS = {"at work", "outside", "sleeping", "busy"};
    private static final int[] AWAY_MINUTES = {30, 60, 120, 240, 480};

    /**
     * Reason chips and length buttons. Choosing a reason only selects it; the
     * length (or UNTIL…) is what starts the timer, so a mistap on a reason
     * cannot hide the stream by accident.
     */
    private void buildAwayChoices() {
        if (awayPresets == null || awayDurs == null) return;
        awayPresets.removeAllViews();
        for (int i = 0; i < AWAY_REASONS.length; i++) {
            final String reason = AWAY_REASONS[i];
            boolean on = reason.equals(awayReason);
            Button chip = smallButton(reason.toUpperCase(),
                on ? R.drawable.bg_btn_go : R.drawable.bg_btn_scene,
                color(on ? R.color.txt : R.color.faint), 9.5f);
            chip.setPadding(0, 0, 0, 0);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(40), 1f);
            if (i > 0) lp.leftMargin = dp(5);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                awayReason = reason;
                buildAwayChoices();
                renderAwayStatus(lastAway);
            });
            awayPresets.addView(chip);
        }

        awayDurs.removeAllViews();
        for (int i = 0; i < AWAY_MINUTES.length; i++) {
            final int minutes = AWAY_MINUTES[i];
            Button len = smallButton(minutes % 60 == 0 ? (minutes / 60) + "H" : minutes + "M",
                R.drawable.bg_btn_scene, color(R.color.txt), 10.5f);
            len.setPadding(0, 0, 0, 0);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(38), 1f);
            if (i > 0) lp.leftMargin = dp(5);
            len.setLayoutParams(lp);
            len.setOnClickListener(v -> setAway(awayReason, minutes, 0));
            awayDurs.addView(len);
        }
    }

    /** "at work · back 18:30 · 2h 14m left", refreshed by every state poll. */
    private void renderAwayStatus(JSONObject away) {
        lastAway = away;
        if (awayStatus == null) return;
        long until = away == null ? 0 : away.optLong("until", 0);
        long now = System.currentTimeMillis();
        if (until > now) {
            awayStatus.setText(away.optString("reason", "away") + "  ·  back " + clock(until)
                + "  ·  " + shortLeft(until - now) + " left");
            awayStatus.setTextColor(color(R.color.txt));
        } else if (until > 0) {
            awayStatus.setText("last timer is over — the overlay shows nothing now");
            awayStatus.setTextColor(color(R.color.faint));
        } else {
            awayStatus.setText(awayReason + " selected  ·  pick a length, or UNTIL… for a return time");
            awayStatus.setTextColor(color(R.color.faint));
        }
    }

    private void setAway(String reason, int minutes, long until) {
        if (api == null) return;
        JSONObject body = new JSONObject();
        try {
            if (reason == null) {
                body.put("action", "clear");
            } else {
                body.put("reason", reason);
                if (until > 0) body.put("until", until);
                else body.put("minutes", minutes);
            }
        } catch (JSONException ignored) {
        }
        post("/api/away", body, reason == null ? "away timer cleared" : "away: " + reason, null);
    }

    /** A return time from the clock: today, or tomorrow when it has passed. */
    private void pickAwayUntil() {
        final java.util.Calendar now = java.util.Calendar.getInstance();
        new android.app.TimePickerDialog(this, (view, hour, minute) -> {
            java.util.Calendar end = java.util.Calendar.getInstance();
            end.set(java.util.Calendar.HOUR_OF_DAY, hour);
            end.set(java.util.Calendar.MINUTE, minute);
            end.set(java.util.Calendar.SECOND, 0);
            end.set(java.util.Calendar.MILLISECOND, 0);
            if (end.getTimeInMillis() <= System.currentTimeMillis() + 60000) {
                end.add(java.util.Calendar.DAY_OF_MONTH, 1);
            }
            setAway(awayReason, 0, end.getTimeInMillis());
        }, now.get(java.util.Calendar.HOUR_OF_DAY), now.get(java.util.Calendar.MINUTE), true).show();
    }

    private static String clock(long at) {
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(at));
    }

    private static String shortLeft(long ms) {
        long mins = Math.max(0, Math.round(ms / 60000.0));
        if (mins < 60) return mins + "m";
        long h = mins / 60;
        long m = mins % 60;
        return m == 0 ? h + "h" : h + "h " + m + "m";
    }

    private void renderTwitch() {
        if (twList == null || state == null) return;
        JSONObject integ = state.optJSONObject("integrations");
        JSONObject tw = integ == null ? null : integ.optJSONObject("twitch");
        if (tw == null) {
            twState.setText("twitch queue not configured");
            twScene.setText("add a \"twitch\" block to config.json");
            twList.removeAllViews();
            return;
        }
        twitchAuto = tw.optBoolean("autoRotate", true);
        String current = tw.isNull("current") ? "" : tw.optString("current", "");
        boolean live = tw.optBoolean("currentLive");
        twState.setText(current.isEmpty() ? "nobody queued" : "showing " + current + (live ? "  ·  LIVE" : "  ·  OFFLINE"));
        twState.setTextColor(live ? 0xFFC8B4FF : 0xFFFFB4B4);

        boolean inScene = tw.optBoolean("inScene");
        String sceneName = tw.optString("scene", "");
        twScene.setText(inScene
            ? "in " + sceneName + " · auto rotation armed"
            : "not in " + sceneName + " · auto rotation idle");

        String err = tw.isNull("error") ? "" : tw.optString("error", "");
        twError.setText(err);
        twError.setVisibility(err.isEmpty() ? View.GONE : View.VISIBLE);

        twAuto.setText(twitchAuto ? "AUTO: ON" : "AUTO: OFF");
        twAuto.setBackgroundResource(twitchAuto ? R.drawable.bg_btn_go : R.drawable.bg_btn);
        twAuto.setTextColor(twitchAuto ? 0xFFC8FFE6 : color(R.color.txt));

        JSONArray list = tw.optJSONArray("streamers");
        StringBuilder sig = new StringBuilder(current).append('|').append(twitchAuto).append('|').append(inScene);
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s == null) continue;
            sig.append('|').append(s.optString("login", "")).append(s.optBoolean("live"))
               .append(s.optInt("viewers")).append(s.optBoolean("current"));
        }
        if (sig.toString().equals(twitchSig)) return;
        twitchSig = sig.toString();

        twList.removeAllViews();
        if (list == null || list.length() == 0) {
            twList.addView(label("the queue is empty — add someone below"));
            return;
        }
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s == null) continue;
            final String login = s.optString("login", "");
            if (login.isEmpty()) continue;
            final boolean isCurrent = s.optBoolean("current");
            final boolean isLive = s.optBoolean("live");
            final int viewers = s.optInt("viewers");

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            rlp.topMargin = dp(i == 0 ? 0 : 6);
            row.setLayoutParams(rlp);

            Button name = smallButton(
                (isCurrent ? "▶ " : "") + login + (isLive ? (viewers > 0 ? "  ·  " + viewers : "  ·  live") : "  ·  off"),
                R.drawable.bg_btn_scene, getColorStateList(R.color.scene_text), 12f);
            name.setSelected(isCurrent);
            name.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(0, dp(44), 1f);
            name.setLayoutParams(nlp);
            name.setOnClickListener(v -> twitchSwitch(login));
            row.addView(name);

            Button up = smallButton("↑", R.drawable.bg_btn, color(R.color.txt), 14f);
            LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(dp(42), dp(44));
            ulp.leftMargin = dp(6);
            up.setLayoutParams(ulp);
            up.setOnClickListener(v -> twitchMove(login, -1));
            row.addView(up);

            Button del = smallButton("✕", R.drawable.bg_btn, 0xFFFFB4B4, 13f);
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(42), dp(44));
            dlp.leftMargin = dp(6);
            del.setLayoutParams(dlp);
            del.setOnClickListener(v -> twitchRemove(login));
            row.addView(del);

            twList.addView(row);
        }
    }

    private Button smallButton(String text, int background, android.content.res.ColorStateList textColor, float size) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTypeface(Typeface.MONOSPACE);
        b.setTextSize(size);
        b.setTextColor(textColor);
        b.setBackgroundResource(background);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(12), 0, dp(12), 0);
        return b;
    }

    private Button smallButton(String text, int background, int textColor, float size) {
        return smallButton(text, background, android.content.res.ColorStateList.valueOf(textColor), size);
    }

    private void twitchSwitch(String login) {
        JSONObject b = new JSONObject();
        try {
            b.put("login", login);
        } catch (JSONException ignored) {
        }
        post("/api/twitch/switch", b, "TWITCH: " + login, null);
    }

    private void twitchMove(String login, int delta) {
        JSONObject b = new JSONObject();
        try {
            b.put("action", "move");
            b.put("login", login);
            b.put("delta", delta);
        } catch (JSONException ignored) {
        }
        post("/api/twitch/streamers", b, null, null);
    }

    private void twitchRemove(final String login) {
        new AlertDialog.Builder(this)
            .setTitle("Remove " + login + "?")
            .setMessage("Takes them out of the queue. If they are on air the relay keeps playing until you pick someone else.")
            .setNegativeButton("CANCEL", null)
            .setPositiveButton("REMOVE", (d, w) -> {
                JSONObject b = new JSONObject();
                try {
                    b.put("action", "remove");
                    b.put("login", login);
                } catch (JSONException ignored) {
                }
                post("/api/twitch/streamers", b, "REMOVED " + login, null);
            })
            .show();
    }

    private void addTwitchStreamer() {
        String text = twInput.getText().toString().trim();
        if (text.isEmpty()) {
            toast("paste a twitch link or channel name");
            return;
        }
        JSONObject b = new JSONObject();
        try {
            b.put("action", "add");
            b.put("url", text);
        } catch (JSONException ignored) {
        }
        twInput.setText("");
        post("/api/twitch/streamers", b, "ADDED TO QUEUE", null);
    }

    private void setTwitchAuto(boolean on) {
        JSONObject b = new JSONObject();
        try {
            b.put("enabled", on);
        } catch (JSONException ignored) {
        }
        post("/api/twitch/auto", b, on ? "AUTO ROTATION ON" : "AUTO ROTATION OFF", null);
    }

    /* ----------------------------------------------------------------- brb */

    private String presetLabel(String preset) {
        if ("trans-gradient".equals(preset)) return "TRANS";
        if ("rainbow-wiggle".equals(preset)) return "RAINBOW";
        if ("shaky".equals(preset)) return "SHAKY";
        if ("glow".equals(preset)) return "GLOW";
        if ("pulse".equals(preset)) return "PULSE";
        if ("plain".equals(preset)) return "PLAIN";
        return preset.toUpperCase(Locale.US);
    }

    private void renderBrb() {
        if (brbList == null || state == null) return;
        JSONObject integ = state.optJSONObject("integrations");
        JSONObject brb = integ == null ? null : integ.optJSONObject("brb");
        if (brb == null) {
            brbStatus.setText("brb texts not configured");
            return;
        }
        buildPresetChips(brb.optJSONArray("presets"));
        brbStatus.setText((brbSelectedId.isEmpty() ? "new text" : "editing") + " · effect " + presetLabel(brbPreset));

        JSONArray items = brb.optJSONArray("items");
        StringBuilder sig = new StringBuilder(brbSelectedId).append('|').append(brbPreset).append('|');
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            sig.append(it.optString("id")).append(':').append(it.optString("text")).append(':').append(it.optString("preset")).append('|');
        }
        if (sig.toString().equals(brbSig)) return;
        brbSig = sig.toString();

        brbList.removeAllViews();
        if (items == null || items.length() == 0) {
            brbList.addView(label("no texts yet — write one below and SAVE"));
            return;
        }
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            final String id = it.optString("id", "");
            final String text = it.optString("text", "");
            final String preset = it.optString("preset", "plain");
            if (id.isEmpty()) continue;

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            rlp.topMargin = dp(i == 0 ? 0 : 6);
            row.setLayoutParams(rlp);

            TextView tag = new TextView(this);
            tag.setText(presetLabel(preset));
            tag.setTypeface(Typeface.MONOSPACE);
            tag.setTextSize(8.5f);
            tag.setTextColor(color(R.color.faint));
            tag.setGravity(android.view.Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(dp(56), dp(44));
            tag.setLayoutParams(tlp);
            row.addView(tag);

            Button body = smallButton(text, R.drawable.bg_btn_scene, getColorStateList(R.color.scene_text), 12f);
            body.setSingleLine(true);
            body.setEllipsize(android.text.TextUtils.TruncateAt.END);
            body.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
            body.setSelected(id.equals(brbSelectedId));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(0, dp(44), 1f);
            blp.leftMargin = dp(4);
            body.setLayoutParams(blp);
            body.setOnClickListener(v -> selectBrb(id, text, preset));
            row.addView(body);

            Button up = smallButton("↑", R.drawable.bg_btn, color(R.color.txt), 14f);
            LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(dp(42), dp(44));
            ulp.leftMargin = dp(6);
            up.setLayoutParams(ulp);
            up.setOnClickListener(v -> brbMove(id));
            row.addView(up);

            Button del = smallButton("✕", R.drawable.bg_btn, 0xFFFFB4B4, 13f);
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(42), dp(44));
            dlp.leftMargin = dp(6);
            del.setLayoutParams(dlp);
            del.setOnClickListener(v -> brbRemove(id, text));
            row.addView(del);

            brbList.addView(row);
        }
    }

    private void buildPresetChips(JSONArray presets) {
        if (brbPresets == null) return;
        List<String> list = new ArrayList<>();
        for (int i = 0; presets != null && i < presets.length(); i++) {
            String p = presets.optString(i, "");
            if (!p.isEmpty()) list.add(p);
        }
        if (list.isEmpty()) {
            list.add("rainbow-wiggle");
            list.add("trans-gradient");
            list.add("shaky");
            list.add("glow");
            list.add("pulse");
            list.add("plain");
        }
        String sig = brbPreset + "|" + list;
        if (sig.equals(brbChipSig)) return;
        brbChipSig = sig;

        brbPresets.removeAllViews();
        for (int i = 0; i < list.size(); i++) {
            final String preset = list.get(i);
            Button chip = new Button(this);
            chip.setText(presetLabel(preset));
            chip.setTextSize(10.5f);
            chip.setTypeface(Typeface.MONOSPACE);
            chip.setAllCaps(false);
            chip.setBackgroundResource(R.drawable.bg_btn_scene);
            chip.setTextColor(getColorStateList(R.color.scene_text));
            chip.setSelected(preset.equals(brbPreset));
            chip.setMinHeight(0);
            chip.setMinimumHeight(0);
            chip.setMinWidth(0);
            chip.setMinimumWidth(0);
            chip.setPadding(dp(14), dp(10), dp(14), dp(10));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.rightMargin = dp(8);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                brbPreset = preset;
                brbChipSig = "";
                renderBrb();
            });
            brbPresets.addView(chip);
        }
    }

    private void selectBrb(String id, String text, String preset) {
        brbSelectedId = id;
        brbPreset = preset;
        brbInput.setText(text);
        brbSig = "";
        brbChipSig = "";
        renderBrb();
    }

    private void newBrb() {
        brbSelectedId = "";
        brbPreset = "rainbow-wiggle";
        brbInput.setText("");
        brbSig = "";
        brbChipSig = "";
        renderBrb();
        brbInput.requestFocus();
    }

    private void saveBrb() {
        String text = brbInput.getText().toString().trim();
        if (text.isEmpty()) {
            toast("type the brb text first");
            return;
        }
        JSONObject b = new JSONObject();
        try {
            b.put("action", brbSelectedId.isEmpty() ? "add" : "update");
            if (!brbSelectedId.isEmpty()) b.put("id", brbSelectedId);
            b.put("text", text);
            b.put("preset", brbPreset);
        } catch (JSONException ignored) {
        }
        brbSig = "";
        post("/api/brb", b, brbSelectedId.isEmpty() ? "TEXT ADDED" : "TEXT SAVED", null);
    }

    private void brbMove(String id) {
        JSONObject b = new JSONObject();
        try {
            b.put("action", "move");
            b.put("id", id);
            b.put("delta", -1);
        } catch (JSONException ignored) {
        }
        post("/api/brb", b, null, null);
    }

    private void brbRemove(final String id, String text) {
        new AlertDialog.Builder(this)
            .setTitle("Delete this text?")
            .setMessage(text)
            .setNegativeButton("CANCEL", null)
            .setPositiveButton("DELETE", (d, w) -> {
                JSONObject b = new JSONObject();
                try {
                    b.put("action", "remove");
                    b.put("id", id);
                } catch (JSONException ignored) {
                }
                if (id.equals(brbSelectedId)) {
                    brbSelectedId = "";
                    brbInput.setText("");
                }
                brbSig = "";
                post("/api/brb", b, "TEXT DELETED", null);
            })
            .show();
    }

    private void renderAudio() {
        if (mixSlider == null) return;
        mixSlider.setEnabled(mixReady);
        mixMute.setEnabled(mixReady);
        mixMute.setText(mixMuted ? "UNMUTE" : "MUTE");
        mixMute.setBackgroundResource(mixMuted ? R.drawable.bg_btn_stop : R.drawable.bg_btn);
        mixMute.setTextColor(mixMuted ? 0xFFFFD8E1 : color(R.color.txt));
        if (!dragging) mixSlider.setProgress(Math.max(0, Math.min(60, mixDb + 60)));

        String value;
        if (!mixReady) value = "OBS off";
        else if (mixMuted) value = "MUTED";
        else if (mixDb <= -60) value = "−∞ dB";
        else value = (mixDb > 0 ? "+" : "") + mixDb + " dB";
        mixVal.setText(value);
        mixVal.setTextColor(mixReady && !mixMuted ? color(R.color.txt) : color(R.color.dim));
    }

    private void renderNowPlaying() {
        if (npTitle == null || nowPlaying == null) return;
        String title = nowPlaying.isNull("title") ? "" : nowPlaying.optString("title", "");
        String artist = nowPlaying.isNull("artist") ? "" : nowPlaying.optString("artist", "");
        String album = nowPlaying.isNull("album") ? "" : nowPlaying.optString("album", "");
        boolean playing = nowPlaying.optBoolean("playing");
        if (!nowPlaying.optBoolean("ok") || title.isEmpty()) {
            npTitle.setText("VLC offline");
            npMeta.setText(
                nowPlaying.isNull("error")
                    ? "statistics interface not reachable"
                    : nowPlaying.optString("error", "")
            );
            npProgress.setText("");
            return;
        }
        npTitle.setText(title);
        String meta = (artist.isEmpty() ? "" : artist) + (album.isEmpty() ? "" : (artist.isEmpty() ? "" : " · ") + album);
        npMeta.setText(meta.isEmpty() ? (playing ? "playing" : "paused") : meta);
        long pos = nowPlaying.optLong("positionMs", 0);
        long len = nowPlaying.optLong("lengthMs", 0);
        npProgress.setText(len > 0 ? mmss(pos) + " / " + mmss(len) : (playing ? "playing" : "paused"));
    }

    private void renderYoutube() {
        if (ytMode == null || state == null) return;
        JSONObject integ = state.optJSONObject("integrations");
        JSONObject yt = integ == null ? null : integ.optJSONObject("youtube");
        if (yt == null) {
            ytMode.setText("youtube not configured");
            return;
        }
        boolean oauth = "oauth".equals(yt.optString("subsMode"));
        boolean configured = yt.optBoolean("configured");
        // How many of the subscriber counters are answering right now; one of
        // them being down is survivable, all of them is not.
        JSONObject srcs = yt.optJSONObject("subSources");
        int live = 0;
        int total = 0;
        if (srcs != null) {
            for (java.util.Iterator<String> it = srcs.keys(); it.hasNext(); ) {
                JSONObject s = srcs.optJSONObject(it.next());
                if (s == null) continue;
                total++;
                if (s.optBoolean("ok")) live++;
            }
        }
        ytMode.setText(
            (configured ? "API KEY OK" : "NO API KEY") +
                " · " + (oauth ? "SUBS BY NAME" : "ROUNDED TOTAL") +
                (total > 0 ? " · " + live + "/" + total + " COUNTERS" : "")
        );
        ytMode.setTextColor(color(configured ? R.color.ok : R.color.like));

        String channel = yt.optString("channelId", "");
        String handle = yt.optString("handle", "");
        String video = yt.optString("videoId", "");
        if (!handle.isEmpty() && !handle.equals(liveHandle)) {
            liveHandle = handle;
            refreshLiveLink();
        }
        ytChannel.setText(
            (channel.isEmpty() ? "@" + handle : channel) +
                (video.isEmpty() ? " · no live video" : " · live " + video)
        );

        int subs = yt.isNull("subs") ? -1 : yt.optInt("subs", -1);
        int likes = yt.isNull("likes") ? -1 : yt.optInt("likes", -1);
        int tracked = yt.optInt("subsTracked", 0);
        JSONObject sc = yt.optJSONObject("socialcounts");
        String estimate = sc == null || sc.isNull("estimation") ? "" : " · live est " + sc.optInt("estimation", 0);
        ytSubs.setText(
            "subs " + (subs < 0 ? "hidden" : String.valueOf(subs)) +
                (oauth ? " · " + tracked + " tracked" : "") + estimate
        );
        ytLikes.setText("likes " + (likes < 0 ? "—" : String.valueOf(likes)));

        // Fill the title/description editors once, from the saved pair, so the
        // fields are not clobbered while the operator is typing in them.
        JSONObject meta = yt.optJSONObject("meta");
        if (!ytInfoLoaded && meta != null) {
            String t = meta.optString("title", "");
            String d = meta.optString("description", "");
            if (!t.isEmpty()) ytTitle.setText(t);
            if (!d.isEmpty()) ytDesc.setText(d);
            ytInfoLoaded = true;
            ytInfoState.setText("saved changes also apply to the next broadcast");
        }

        // The latency class YouTube actually gave THIS broadcast. It is fixed
        // when the broadcast starts, so GO LIVE is the only moment it is
        // decided — this line is what tells you whether the press worked.
        JSONObject lat = yt.optJSONObject("latency");
        String latClass = lat == null ? "" : lat.optString("class", "");
        String latError = lat == null || lat.isNull("error") ? "" : lat.optString("error", "");
        long latAt = lat == null || lat.isNull("at") ? 0 : lat.optLong("at", 0);
        long latStarted = lat == null || lat.isNull("startedAt") ? 0 : lat.optLong("startedAt", 0);
        String latName =
            "ULTRA_LOW".equals(latClass) ? "Ultra-low"
                : "LOW".equals(latClass) ? "Low"
                : "NORMAL".equals(latClass) ? "Normal" : latClass;
        if (!latClass.isEmpty()) {
            boolean ultra = "ULTRA_LOW".equals(latClass);
            text(
                ytLatency,
                "latency: " + latName + (ultra ? " ✓" : " — not ultra-low")
                    + (latAt > 0 ? " · read " + latAgo(latAt) : ""),
                ultra ? R.color.ok : R.color.like
            );
        } else if (!latError.isEmpty() && latStarted == 0) {
            text(ytLatency, "latency: " + latError, R.color.yt);
        } else if (latStarted > 0) {
            text(
                ytLatency,
                latError.isEmpty() ? "latency: reading after stream start…" : "latency: " + latError + " · retrying",
                latError.isEmpty() ? R.color.like : R.color.yt
            );
        } else {
            text(ytLatency, "latency: not read yet — reads after every stream start", R.color.faint);
        }

        // A switch runs in the background on the timer (end → create → bind →
        // go live, ~30 s), so its step replaces the class line while it runs.
        // A failure stays for ten minutes, then the class line takes over.
        JSONObject sw = yt.optJSONObject("switch");
        String step = sw == null ? "" : sw.optString("step", "");
        boolean switching = !step.isEmpty() && !sw.optBoolean("done", false);
        boolean failed =
            "failed".equals(step) && System.currentTimeMillis() - sw.optLong("at", 0) < 10 * 60 * 1000L;
        if (failed) {
            text(ytLatency, "switch failed: " + sw.optString("error", "unknown"), R.color.yt);
        } else if (switching) {
            text(ytLatency, "switching to ultra-low · " + step + "…", R.color.like);
        }
        ytUltra.setEnabled(!switching);
        ytUltra.setText(switching ? "SWITCHING…" : "RESTART → ULTRA-LOW");

        // Auto-fix: after every GO LIVE the class is read anyway, so when it is
        // not Ultra-low the timer redoes the switch itself. GAVE UP means the
        // attempts ran out — the Studio stream setting is what to look at then.
        JSONObject au = yt.optJSONObject("autoUltra");
        boolean autoOn = au != null && au.optBoolean("enabled");
        boolean autoGaveUp = au != null && au.optBoolean("gaveUp");
        boolean linked = yt.optBoolean("oauthConnected");
        ytAuto.setText(autoGaveUp ? "AUTO-FIX: GAVE UP" : autoOn ? "AUTO-FIX: ON" : "AUTO-FIX: OFF");
        ytAuto.setEnabled(linked);
        ytAuto.setTextColor(color(!linked ? R.color.faint : autoOn ? R.color.ok : R.color.txt));
        if (autoGaveUp) ytLatency.setText(ytLatency.getText() + " · auto-fix gave up");

        long last = yt.isNull("lastCheck") ? 0 : yt.optLong("lastCheck", 0);
        ytLast.setText(last == 0 ? "never synced" : "last sync " + hhmm(last));
        String error = yt.isNull("error") ? "" : yt.optString("error", "");
        String subsError = yt.isNull("subsError") ? "" : yt.optString("subsError", "");
        if (!error.isEmpty() || !subsError.isEmpty()) ytError.setText(!error.isEmpty() ? error : subsError);
        else if (total > 0 && live == 0) ytError.setText("every subscriber counter is down — no subs can be counted");
        else if (total > 0 && live < total) ytError.setText((total - live) + " counter(s) down · the rest still count subs");
        else ytError.setText("");
    }

    /** The permanent alias: always opens whatever the channel is live with. */
    private String liveUrl() {
        return "https://www.youtube.com/@" + liveHandle + "/live";
    }

    private void refreshLiveLink() {
        if (ytLink == null) return;
        // One template for the URL; the label is that URL minus the scheme, so
        // the two can never disagree.
        ytLink.setText(liveUrl().replace("https://www.youtube.com/", "") + " ↗");
        ytLink.setContentDescription("open " + liveUrl());
    }

    private void openLiveLink() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(liveUrl())));
        } catch (Exception e) {
            toast("no browser for that link");
        }
    }

    private void copyLiveLink() {
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (cm == null) {
            toast("clipboard unavailable");
            return;
        }
        cm.setPrimaryClip(ClipData.newPlainText("live link", liveUrl()));
        toast("LIVE LINK COPIED");
    }

    private void renderKofi() {
        if (kofiState == null || state == null) return;
        JSONObject integ = state.optJSONObject("integrations");
        JSONObject kofi = integ == null ? null : integ.optJSONObject("kofi");
        if (kofi == null) {
            kofiState.setText("ko-fi not configured");
            return;
        }
        boolean on = kofi.optBoolean("enabled");
        kofiState.setText(on ? "WEBHOOK READY · /kofi" : "WEBHOOK DISABLED (no verification token)");
        kofiState.setTextColor(color(on ? R.color.kofi : R.color.like));
        kofiHits.setText("donations " + kofi.optInt("hits", 0));

        JSONObject last = kofi.optJSONObject("lastEvent");
        if (last == null) {
            kofiLast.setText("nothing yet");
        } else {
            String who = last.isNull("name") ? "Anonymous" : last.optString("name", "Anonymous");
            String amount = last.isNull("amountText") ? "" : last.optString("amountText", "");
            long at = last.optLong("at", 0);
            kofiLast.setText(who + (amount.isEmpty() ? "" : " · " + amount) + (at > 0 ? " · " + hhmm(at) : ""));
        }
    }

    private void renderSystem() {
        if (sysObs == null || state == null) return;
        JSONObject integ = state.optJSONObject("integrations");
        JSONObject ob = integ == null ? null : integ.optJSONObject("obs");
        if (ob != null) {
            sysObs.setText(
                "OBS " + (ob.optBoolean("enabled") ? "on" : "off") +
                    " · " + (ob.optBoolean("connected") ? "connected" : "disconnected") +
                    (ob.optBoolean("streaming") ? " · streaming" : "") +
                    "\n" + ob.optString("url", "")
            );
        }
        sysServer.setText("server " + base);
        if (health != null) {
            long up = health.optLong("uptime", 0);
            sysUptime.setText(
                "uptime " + shortDur(up * 1000) + " · sse " + health.optInt("sseClients", 0) +
                    "\nobs " + health.optBoolean("obsConnected") + " · vlc " + health.optString("vlcState", "?")
            );
            sysRemote.setText(
                "phone access " + (health.optBoolean("remoteEnabled") ? "enabled" : "off") +
                    " · kofi " + (health.optBoolean("kofiConfigured") ? "ok" : "missing token")
            );
        }
    }

    private void renderFeed() {
        if (feedBox == null) return;
        fillLog(feedBox, 4);
        // Say when the newest event was, so a quiet hour reads as quiet and not
        // as a frozen app.
        if (feedLabel != null) {
            JSONArray log = state == null ? null : state.optJSONArray("log");
            JSONObject last = log == null || log.length() == 0
                    ? null : log.optJSONObject(log.length() - 1);
            if (last == null) {
                feedLabel.setText("ACTIVITY · nothing yet");
            } else {
                long at = last.optLong("at", 0);
                String age = ageText(System.currentTimeMillis() + offset - at);
                feedLabel.setText("ACTIVITY · last " + hhmm(at) + (age.isEmpty() ? "" : " · " + age + " ago"));
            }
        }
    }

    /** "5m", "2h 43m", "1d 6h"; empty under a minute. */
    private static String ageText(long ms) {
        long min = Math.max(0, ms) / 60000;
        if (min < 1) return "";
        if (min < 60) return min + "m";
        long h = min / 60;
        if (h < 24) return h + "h " + (min % 60) + "m";
        return (h / 24) + "d " + (h % 24) + "h";
    }

    private void renderLog() {
        if (logBox == null) return;
        fillLog(logBox, 20);
    }

    private void fillLog(LinearLayout box, int max) {
        box.removeAllViews();
        JSONArray log = state == null ? null : state.optJSONArray("log");
        int shown = 0;

        if (log != null) {
            for (int i = log.length() - 1; i >= 0 && shown < max; i--) {
                JSONObject e = log.optJSONObject(i);
                if (e == null) continue;
                String label = typeLabel(e.optString("type", ""));
                if (label == null) continue;
                String name = e.optString("name", "");

                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setPadding(0, dp(2), 0, dp(2));

                TextView left = label(label + (name.isEmpty() ? "" : " · " + name));
                left.setTextColor(0xFFD7D7E0);
                TextView right = label(boostText(e.optLong("amountMs", 0)) + " · " + hhmm(e.optLong("at", 0)));

                row.addView(left, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
                row.addView(right, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ));
                box.addView(row);
                shown++;
            }
        }
        if (shown == 0) box.addView(label("nothing yet"));
    }

    /* -------------------------------------------------------------- actions */

    private void syncYouTube() {
        toast("syncing youtube…");
        post("/api/youtube/check", null, "YOUTUBE SYNCED", null);
    }

    /**
     * Ultra-low is only reachable by a *new* broadcast, so the switch ends the
     * running one. That costs the live link everybody has, which is the one
     * thing worth stopping to confirm.
     */
    /** "Auto-fix" state straight from the last state push, so the toggle always
     *  sends the opposite of what the screen is showing. */
    private boolean autoUltraEnabled() {
        if (state == null) return false;
        JSONObject integ = state.optJSONObject("integrations");
        JSONObject yt = integ == null ? null : integ.optJSONObject("youtube");
        JSONObject au = yt == null ? null : yt.optJSONObject("autoUltra");
        return au != null && au.optBoolean("enabled");
    }

    private void toggleAutoUltra() {
        boolean on = !autoUltraEnabled();
        post(
            "/api/youtube/auto-ultra",
            body("enabled", on),
            on ? "AUTO-FIX ON" : "AUTO-FIX OFF",
            null
        );
    }

    /** Pushes the title/description to the broadcast that is live right now. */
    private void saveStreamInfo() {
        String title = ytTitle.getText().toString().trim();
        if (title.isEmpty()) {
            toast("the title cannot be empty");
            return;
        }
        JSONObject b = new JSONObject();
        try {
            b.put("title", title);
            b.put("description", ytDesc.getText().toString());
        } catch (JSONException ignored) {
        }
        ytInfoState.setText("saving title + description…");
        post("/api/youtube/meta", b, "STREAM INFO SAVED", () -> ytInfoState.setText("live on youtube — check the watch page"));
    }

    /**
     * Posts into the live chat as the channel. YouTube's API has no pin call,
     * so the toast says where the pin has to happen.
     */
    private void postChat() {
        String text = ytChat.getText().toString().trim();
        if (text.isEmpty()) {
            toast("type a chat message first");
            return;
        }
        JSONObject b = new JSONObject();
        try {
            b.put("text", text);
        } catch (JSONException ignored) {
        }
        ytInfoState.setText("posting to live chat…");
        post("/api/youtube/chat", b, "CHAT POSTED · PIN IT IN STUDIO", () -> {
            ytChat.setText("");
            ytInfoState.setText("posted — YouTube has no pin API, pin it in Studio");
        });
    }

    private void confirmSwitchLatency() {
        new AlertDialog.Builder(this)
            .setTitle("Restart as Ultra-low?")
            .setMessage(
                "Ends this broadcast and starts a new one with Ultra-low latency (~2–5 s).\n\n"
                    + "The current live link becomes the replay — the new stream gets a new link. "
                    + "@EmilliFTL/live always follows whatever is live."
            )
            .setNegativeButton("CANCEL", null)
            .setPositiveButton(
                "RESTART",
                (d, w) -> post("/api/youtube/restart", body("latency", "ultraLow"), "SWITCHING TO ULTRA-LOW…", null)
            )
            .show();
    }

    private void saveStartTime() {
        String value = startAtInput.getText().toString().trim();
        if (!value.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}")) {
            toast("use YYYY-MM-DDTHH:MM");
            return;
        }
        JSONObject b = new JSONObject();
        try {
            b.put("startAt", value);
        } catch (JSONException ignored) {
        }
        post("/api/settings", b, "START TIME SAVED", null);
    }

    private void confirmReset() {
        new AlertDialog.Builder(this)
            .setTitle("Reset the counter?")
            .setMessage("Clears every boost and count, keeps the start time and the Ko-fi de-duplication list.")
            .setNegativeButton("CANCEL", null)
            .setPositiveButton("RESET", (d, w) -> post("/api/reset", null, "RESET", null))
            .show();
    }

    private void pickScene(final String name) {
        if (name.equals(currentScene)) return;
        JSONObject b = new JSONObject();
        try {
            b.put("sceneName", name);
        } catch (JSONException ignored) {
        }
        post("/api/obs/scene", b, "SCENE: " + name, this::refreshScenes);
    }

    /* --------------------------------------------------------- alert preview */

    /**
     * Replay one alert face: draws it on this phone and asks the server to send
     * the same card to the OBS overlay. Nothing is counted either way.
     */
    private void replay(String type) {
        String name = alertName.getText().toString().trim();
        String amount = alertAmount.getText().toString().trim();
        String message = alertMessage.getText().toString().trim();

        JSONObject b = body("type", type);
        with(b, "name", name);
        with(b, "amountText", amount);
        with(b, "message", message);

        JSONObject local = new JSONObject();
        with(local, "type", type);
        with(local, "test", true);
        with(local, "amountMs", amountMsFor(type));
        with(local, "name", name.isEmpty() ? sampleName(type) : name);
        with(local, "amountText", amount.isEmpty() ? sampleAmount(type) : amount);
        with(local, "message", message.isEmpty() ? sampleMessage(type) : message);
        showAlertPreview(local);

        post("/api/replay", b, null, null);
    }

    private static String sampleName(String type) {
        return "kofi".equals(type) ? "test_supporter" : "test_viewer";
    }

    private static String sampleAmount(String type) {
        return "kofi".equals(type) ? "€5" : "";
    }

    private static String sampleMessage(String type) {
        return "kofi".equals(type) ? "for the 24h run!" : "";
    }

    /** The notification card from notifications.html, rebuilt with native views. */
    private void showAlertPreview(JSONObject n) {
        if (alertPreview == null || n == null) return;
        final String type = n.optString("type", "sub");
        final int color = alertColor(type);
        String who = n.optString("name", "");
        if (who.isEmpty()) who = "Someone";
        String message = n.optString("message", "");
        String cash = n.optString("amountText", "");
        long amountMs = n.optLong("amountMs", amountMsFor(type));

        alertPreview.removeAllViews();

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF20A0A0E);
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), 0x1AFFFFFF);
        card.setBackground(bg);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(12), dp(14), dp(12));

        View stripe = new View(this);
        GradientDrawable sg = new GradientDrawable();
        sg.setColor(color);
        sg.setCornerRadius(dp(2));
        stripe.setBackground(sg);
        row.addView(stripe, new LinearLayout.LayoutParams(dp(4), dp(46)));

        TextView glyph = new TextView(this);
        glyph.setText(alertGlyph(type));
        glyph.setTextColor(color);
        glyph.setTextSize(17);
        glyph.setGravity(Gravity.CENTER);
        GradientDrawable ig = new GradientDrawable();
        ig.setColor(withAlpha(color, 0x26));
        ig.setCornerRadius(dp(10));
        ig.setStroke(dp(1), withAlpha(color, 0x59));
        glyph.setBackground(ig);
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(dp(40), dp(40));
        glp.leftMargin = dp(10);
        row.addView(glyph, glp);

        LinearLayout text = new LinearLayout(this);
        text.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams tlp =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        tlp.leftMargin = dp(10);
        row.addView(text, tlp);

        TextView kicker = new TextView(this);
        kicker.setText(alertAction(type) + (n.optBoolean("test") ? " · TEST" : ""));
        kicker.setTextColor(color);
        kicker.setTextSize(9.5f);
        kicker.setLetterSpacing(0.14f);
        kicker.setTypeface(Typeface.MONOSPACE);
        text.addView(kicker);

        TextView name = new TextView(this);
        name.setText(who);
        name.setTextColor(0xFFF4F4F7);
        name.setTextSize(15);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        text.addView(name);

        if (!message.isEmpty()) {
            TextView msg = new TextView(this);
            msg.setText(message);
            msg.setTextColor(0xFFB6B6C4);
            msg.setTextSize(11.5f);
            msg.setMaxLines(2);
            msg.setEllipsize(android.text.TextUtils.TruncateAt.END);
            text.addView(msg);
        }

        LinearLayout amt = new LinearLayout(this);
        amt.setOrientation(LinearLayout.VERTICAL);
        amt.setGravity(Gravity.END);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        alp.leftMargin = dp(8);
        row.addView(amt, alp);

        if (!cash.isEmpty()) {
            TextView c = new TextView(this);
            c.setText(cash);
            c.setTextColor(color);
            c.setTextSize(15);
            c.setTypeface(Typeface.DEFAULT_BOLD);
            c.setGravity(Gravity.END);
            amt.addView(c);
        }
        TextView time = new TextView(this);
        time.setText(alertTime(amountMs));
        time.setTextColor(0xFF8D8D9B);
        time.setTextSize(10.5f);
        time.setLetterSpacing(0.04f);
        time.setGravity(Gravity.END);
        amt.addView(time);

        card.addView(row);

        View bar = new View(this);
        GradientDrawable bgb = new GradientDrawable();
        bgb.setColor(0x29FFFFFF);
        bar.setBackground(bgb);
        card.addView(bar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(2)));

        alertPreview.addView(card);
        final View shown = card;
        // The card sits low on the LIVE tab, so bring it into view or the whole
        // check is hidden under the navigation bar.
        if (tab == 0) {
            shown.postDelayed(() -> {
                ScrollView page = findViewById(R.id.pageScroll);
                if (page == null) return;
                int want = alertPreview.getBottom() - page.getHeight() + dp(20);
                page.smoothScrollTo(0, Math.max(0, want));
            }, 90);
        }

        // Slide in and drain exactly like the overlay card does.
        shown.setAlpha(0f);
        shown.setTranslationX(dp(70));
        shown.animate().alpha(1f).translationX(0f).setDuration(380)
                .setInterpolator(new DecelerateInterpolator()).start();
        bar.setPivotX(0f);
        bar.animate().scaleX(0f).setDuration(6000)
                .setInterpolator(new LinearInterpolator()).start();

        shown.postDelayed(() -> {
            if (shown.getParent() != alertPreview) return;
            shown.animate().alpha(0f).translationX(dp(70)).setDuration(300).start();
            shown.postDelayed(() -> {
                if (alertPreview != null && shown.getParent() == alertPreview) {
                    alertPreview.removeView(shown);
                }
            }, 320);
        }, 6000);
    }

    private static int alertColor(String type) {
        if ("kofi".equals(type)) return 0xFF5CC8F2;
        if ("like".equals(type)) return 0xFFFFA76B;
        return 0xFFFF6B85;
    }

    private static String alertAction(String type) {
        if ("kofi".equals(type)) return "DONATED";
        if ("like".equals(type)) return "LIKED THE STREAM";
        return "SUBSCRIBED";
    }

    private static String alertGlyph(String type) {
        if ("kofi".equals(type)) return "€";
        if ("like".equals(type)) return "♥";
        return "+";
    }

    private static long amountMsFor(String type) {
        if ("kofi".equals(type)) return 1800000;
        if ("like".equals(type)) return 30000;
        return 300000;
    }

    private static String alertTime(long ms) {
        long s = Math.round(ms / 1000.0);
        if (s >= 3600) return "+" + (s / 3600) + "h";
        if (s >= 60) return "+" + (s / 60) + ":" + String.format(Locale.US, "%02d", s % 60);
        return "+0:" + String.format(Locale.US, "%02d", s);
    }

    private static int withAlpha(int color, int alpha) {
        return (color & 0x00FFFFFF) | ((alpha & 0xFF) << 24);
    }

    private static JSONObject with(JSONObject o, String key, Object value) {
        try {
            o.put(key, value);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private void post(final String path, JSONObject payload, final String okMessage, final Runnable after) {
        if (api == null) return;
        final Api a = api;
        final JSONObject body = payload == null ? new JSONObject() : payload;
        net.execute(() -> {
            try {
                final JSONObject r = a.post(path, body);
                final boolean ok = r.optBoolean("ok", false);
                final String message = ok ? okMessage : r.optString("error", "failed");
                final JSONObject newState = r.optJSONObject("state");
                ui.post(() -> {
                    if (message != null && !message.isEmpty()) toast(message);
                    if (newState != null) applyState(newState);
                    if (after != null) after.run();
                    else fetchState();
                });
            } catch (Api.Unauthorized e) {
                ui.post(this::sessionLost);
            } catch (IOException e) {
                ui.post(() -> toast("no connection"));
            }
        });
    }

    private void setVolumeDb(int db) {
        final int clamped = Math.max(-60, Math.min(0, db));
        mixDb = clamped;
        mixReady = true;
        renderAudio();
        sendVolume();
    }

    private void nudgeVolume(int delta) {
        setVolumeDb(Math.round(mixDb) + delta);
    }

    private void sendVolume() {
        if (api == null || !mixReady) return;
        final JSONObject body = new JSONObject();
        try {
            body.put("volumeMul", mixDb <= -60 ? 0.001 : Math.pow(10, mixDb / 20.0));
        } catch (JSONException e) {
            return;
        }
        final Api a = api;
        net.execute(() -> {
            try {
                final JSONObject r = a.post("/api/ytpmvs/audio", body);
                ui.post(() -> {
                    if (r.optBoolean("ok")) {
                        mixMuted = r.optBoolean("muted", mixMuted);
                        mixDb = (int) Math.round(r.optDouble("volumeDb", mixDb));
                        mixReady = true;
                        renderAudio();
                    } else {
                        toast("music: " + r.optString("error", "failed"));
                    }
                });
            } catch (IOException ignored) {
            }
        });
    }

    /* -------------------------------------------------------------- helpers */

    /** Android 15+ draws edge to edge, so the bars have to be padded out. */
    private void applyInsets(View root) {
        if (root == null) return;
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(dp(12), dp(10) + top, dp(12), dp(24) + bottom);
            return insets;
        });
        root.requestApplyInsets();
    }

    /** The dashboard is dark; ask for light status bar icons. */
    private void lightSystemBars() {
        if (Build.VERSION.SDK_INT < 30) return;
        try {
            View decor = getWindow() == null ? null : getWindow().getDecorView();
            WindowInsetsController controller = decor == null ? null : decor.getWindowInsetsController();
            if (controller == null) return;
            controller.setSystemBarsAppearance(
                0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            );
        } catch (RuntimeException ignored) {
            // Window not attached yet; the bars keep their default look.
        }
    }

    private void chip(String text, int background, int color) {
        if (statusChip == null) return;
        statusChip.setText(text);
        statusChip.setBackgroundResource(background);
        statusChip.setTextColor(color);
    }

    private void text(TextView view, String value, int colorRes) {
        if (view == null) return;
        view.setText(value);
        view.setTextColor(color(colorRes));
    }

    private TextView label(String value) {
        TextView t = new TextView(this);
        t.setTypeface(Typeface.MONOSPACE);
        t.setTextSize(10.5f);
        t.setTextColor(color(R.color.faint));
        t.setText(value);
        return t;
    }

    private int color(int res) {
        return getColor(res);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private static JSONObject body(String key, Object value) {
        JSONObject o = new JSONObject();
        try {
            o.put(key, value);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private static String typeLabel(String type) {
        if ("sub".equals(type)) return "SUB";
        if ("kofi".equals(type)) return "KO-FI";
        if ("like".equals(type)) return "LIKE";
        return null;
    }

    private static String clockText(long ms) {
        long t = Math.max(0, Math.abs(ms) / 1000);
        long h = t / 3600;
        long m = (t % 3600) / 60;
        long s = t % 60;
        return (ms < 0 ? "-" : "") + String.format(Locale.US, "%02d:%02d:%02d", h, m, s);
    }

    private static String shortDur(long ms) {
        long t = Math.round(Math.abs(ms) / 1000.0);
        long h = t / 3600;
        long m = Math.round((t % 3600) / 60.0);
        if (h > 0 && m > 0) return h + "h " + m + "m";
        if (h > 0) return h + "h";
        return m + "m";
    }

    private static String boostText(long ms) {
        long t = Math.round(ms / 1000.0);
        if (t >= 3600) return "+" + (t / 3600) + "h";
        if (t >= 60) return String.format(Locale.US, "+%d:%02d", t / 60, t % 60);
        return String.format(Locale.US, "+0:%02d", t);
    }

    /** "just now" / "14m ago" — the same wording the phone remote uses. */
    private static String latAgo(long ts) {
        long s = Math.max(0, (System.currentTimeMillis() - ts) / 1000);
        if (s < 5) return "just now";
        if (s < 60) return s + "s ago";
        if (s < 3600) return Math.round(s / 60.0) + "m ago";
        return Math.round(s / 3600.0) + "h ago";
    }

    private static String mmss(long ms) {
        long t = Math.max(0, ms / 1000);
        return String.format(Locale.US, "%d:%02d", t / 60, t % 60);
    }

    private static String hhmm(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.US).format(new Date(ms));
    }

    private static String dayLabel(long ms) {
        Date d = new Date(ms);
        Date today = new Date();
        SimpleDateFormat key = new SimpleDateFormat("yyyyMMdd", Locale.US);
        if (key.format(d).equals(key.format(today))) return "";
        Date tomorrow = new Date(today.getTime() + 86400000L);
        if (key.format(d).equals(key.format(tomorrow))) return "tomorrow ";
        return new SimpleDateFormat("MMM d", Locale.getDefault()).format(d) + " ";
    }

    private static long parseStart(String value) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US);
            f.setLenient(false);
            Date d = f.parse(value);
            return d == null ? 0 : d.getTime();
        } catch (Exception e) {
            return 0;
        }
    }

    private static CharSequence styled(String pre, String bold, String post) {
        SpannableStringBuilder sb = new SpannableStringBuilder(pre).append(bold).append(post);
        sb.setSpan(new StyleSpan(Typeface.BOLD), pre.length(), pre.length() + bold.length(), 0);
        return sb;
    }
}
