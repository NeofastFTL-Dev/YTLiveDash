package ftl.emilli.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The whole network layer: JSON in, JSON out, one session cookie.
 * Nothing here touches the UI thread.
 */
final class Api {
    static final String COOKIE = "emilli_remote";
    private static final String UA = "EmilliRemote/2.0";

    /** Thrown when the server forgot us; the activity sends the user to sign-in. */
    static final class Unauthorized extends IOException {
        Unauthorized() { super("unauthorized"); }
    }

    private final String base;
    private final String cookie;

    Api(String base, String cookie) {
        this.base = base;
        this.cookie = cookie;
    }

    JSONObject get(String path) throws IOException {
        return send("GET", path, null);
    }

    JSONObject post(String path, JSONObject body) throws IOException {
        return send("POST", path, body == null ? new JSONObject() : body);
    }

    /**
     * A request whose body is read line by line (the /api/events SSE stream).
     * The caller owns the connection and has to disconnect it.
     */
    HttpURLConnection stream(String path) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod("GET");
        c.setConnectTimeout(8000);
        c.setReadTimeout(45000);
        c.setRequestProperty("Accept", "text/event-stream");
        c.setRequestProperty("Cache-Control", "no-cache");
        c.setRequestProperty("User-Agent", UA);
        if (cookie != null) c.setRequestProperty("Cookie", COOKIE + "=" + cookie);
        return c;
    }

    /**
     * A response that is not JSON (the scene render): the raw bytes, ready for
     * BitmapFactory. Nothing here touches the UI thread.
     */
    byte[] bytes(String path) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod("GET");
        c.setConnectTimeout(8000);
        c.setReadTimeout(12000);
        c.setRequestProperty("Accept", "image/jpeg");
        c.setRequestProperty("User-Agent", UA);
        if (cookie != null) c.setRequestProperty("Cookie", COOKIE + "=" + cookie);

        int code = c.getResponseCode();
        if (code == 401) {
            drain(c.getErrorStream());
            c.disconnect();
            throw new Unauthorized();
        }
        if (code != 200) {
            String why = drain(c.getErrorStream());
            c.disconnect();
            throw new IOException(why.isEmpty() ? "HTTP " + code : why);
        }
        InputStream in = c.getInputStream();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        c.disconnect();
        return buf.toByteArray();
    }

    private JSONObject send(String method, String path, JSONObject body) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(12000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", UA);
        if (cookie != null) c.setRequestProperty("Cookie", COOKIE + "=" + cookie);

        if (body != null) {
            byte[] out = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(out.length);
            c.setRequestProperty("Content-Type", "application/json");
            OutputStream os = c.getOutputStream();
            try {
                os.write(out);
            } finally {
                os.close();
            }
        }

        int code = c.getResponseCode();
        String text = drain(code >= 400 ? c.getErrorStream() : c.getInputStream());
        c.disconnect();

        if (code == 401) throw new Unauthorized();

        JSONObject o;
        try {
            o = new JSONObject(text.isEmpty() ? "{}" : text);
        } catch (JSONException e) {
            o = new JSONObject();
        }
        if (code >= 400) {
            try {
                o.put("ok", false);
                if (!o.has("error")) o.put("error", "HTTP " + code);
            } catch (JSONException ignored) {
            }
        }
        return o;
    }

    /** Signs in with the PIN (or the long token) and returns the session cookie. */
    static String login(String base, String secret) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + "/remote/login").openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(8000);
        c.setReadTimeout(12000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", UA);

        JSONObject body = new JSONObject();
        try {
            body.put("token", secret);
        } catch (JSONException ignored) {
        }
        byte[] out = body.toString().getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(out.length);
        OutputStream os = c.getOutputStream();
        try {
            os.write(out);
        } finally {
            os.close();
        }

        int code = c.getResponseCode();
        String setCookie = c.getHeaderField("Set-Cookie");
        drain(code >= 400 ? c.getErrorStream() : c.getInputStream());
        c.disconnect();

        if ((code != 303 && code != 302 && code != 307) || setCookie == null) return null;
        String first = setCookie.split(";", 2)[0].trim();
        int eq = first.indexOf('=');
        if (eq <= 0 || !COOKIE.equals(first.substring(0, eq))) return null;
        String value = first.substring(eq + 1);
        return value.isEmpty() ? null : value;
    }

    /** "192.168.100.73:8123" → "http://192.168.100.73:8123"; https is kept. */
    static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme();
        String authority = u.getAuthority();
        if (scheme == null || authority == null || authority.isEmpty()) return null;
        return scheme + "://" + authority;
    }

    private static String drain(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }
}

/** Address and session, remembered between launches. */
final class Store {
    private static final String FILE = "emilli-remote";

    private Store() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String base(Context c) {
        return prefs(c).getString("base", null);
    }

    static String cookie(Context c) {
        return prefs(c).getString("cookie", null);
    }

    static void save(Context c, String base, String cookie) {
        prefs(c).edit().putString("base", base).putString("cookie", cookie).apply();
    }

    static void dropSession(Context c) {
        prefs(c).edit().remove("cookie").apply();
    }
}
