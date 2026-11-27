package ftl.emilli.remote;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The scene as OBS renders it, with a box around every source: drag a box and
 * the source moves on the stream. Built for thumbs, so a box can be grabbed a
 * little outside its edge and the box follows the finger before OBS is told.
 */
public final class SceneCanvas extends View {

    /** What the panel around the canvas hears back. */
    public interface Listener {
        /** A source was let go at this top-left corner on the canvas. */
        void onDrop(int sceneItemId, String name, int left, int top);

        /** A source is being dragged (or was tapped), for the readout line. */
        void onPick(String name, int left, int top);
    }

    private static final class Box {
        int id;
        String name = "";
        int left, top, w, h;
        boolean enabled = true;
    }

    private final Paint edgePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint livePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint chipPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint notePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF box = new RectF();

    private final List<Box> boxes = new ArrayList<>();
    private Bitmap frame;
    private int canvasW = 1920;
    private int canvasH = 1080;
    private int selected = -1;
    private int grabbed = -1;
    private float grabDx;
    private float grabDy;
    private String note = "waiting for OBS…";
    private Listener listener;

    public SceneCanvas(Context context) {
        this(context, null);
    }

    public SceneCanvas(Context context, AttributeSet attrs) {
        super(context, attrs);
        float d = getResources().getDisplayMetrics().density;
        edgePaint.setStyle(Paint.Style.STROKE);
        edgePaint.setStrokeWidth(Math.max(1f, d));
        edgePaint.setColor(0x55FFFFFF);
        livePaint.setStyle(Paint.Style.STROKE);
        livePaint.setStrokeWidth(Math.max(2f, d * 1.5f));
        livePaint.setColor(0xFFFFC857);
        chipPaint.setColor(0xE6000000);
        textPaint.setColor(0xFFFFE7A3);
        textPaint.setTextSize(11f * d);
        notePaint.setColor(0xFF8A94A6);
        notePaint.setTextSize(11f * d);
    }

    void setListener(Listener l) {
        listener = l;
    }

    /** The newest render from OBS; the old one is freed here. */
    void setFrame(Bitmap next) {
        if (frame == next) {
            invalidate();
            return;
        }
        if (frame != null && !frame.isRecycled()) frame.recycle();
        frame = next;
        invalidate();
    }

    void setNote(String text) {
        note = text == null || text.isEmpty() ? "waiting for OBS…" : text;
        invalidate();
    }

    boolean isDragging() {
        return grabbed >= 0;
    }

    /** Replace the boxes with the scene's current sources (same order as OBS). */
    void setSources(JSONArray items, int width, int height) {
        canvasW = width > 0 ? width : 1920;
        canvasH = height > 0 ? height : 1080;
        int keep = selected >= 0 && selected < boxes.size() ? boxes.get(selected).id : -1;
        boxes.clear();
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null) continue;
            Box b = new Box();
            b.id = o.optInt("id", -1);
            b.name = o.optString("name", "");
            b.left = o.optInt("left", 0);
            b.top = o.optInt("top", 0);
            b.w = Math.round((float) o.optDouble("width", 0));
            b.h = Math.round((float) o.optDouble("height", 0));
            b.enabled = o.optBoolean("enabled", true);
            if (b.id <= 0) continue;
            boxes.add(b);
        }
        selected = -1;
        for (int i = 0; i < boxes.size(); i++) if (boxes.get(i).id == keep) selected = i;
        invalidate();
    }

    private float scale() {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return 0f;
        return Math.min(w / (float) canvasW, h / (float) canvasH);
    }

    private float offX(float s) {
        return (getWidth() - canvasW * s) / 2f;
    }

    private float offY(float s) {
        return (getHeight() - canvasH * s) / 2f;
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        // The canvas is 16:9 whatever the phone's width is, so the picture never
        // gets squashed and the boxes stay where OBS puts them.
        int w = MeasureSpec.getSize(widthSpec);
        if (w <= 0) w = getResources().getDisplayMetrics().widthPixels;
        setMeasuredDimension(w, Math.max(1, Math.round(w * 9f / 16f)));
    }

    @Override
    protected void onDraw(Canvas c) {
        float s = scale();
        if (s <= 0f) return;
        float ox = offX(s);
        float oy = offY(s);
        c.drawColor(0xFF05070A);

        if (frame != null && !frame.isRecycled()) {
            box.set(ox, oy, ox + canvasW * s, oy + canvasH * s);
            c.drawBitmap(frame, null, box, null);
        } else {
            c.drawText(note, ox + 12f, oy + canvasH * s / 2f, notePaint);
        }

        for (int i = 0; i < boxes.size(); i++) {
            Box b = boxes.get(i);
            if (!b.enabled || b.w <= 0 || b.h <= 0) continue;
            box.set(ox + b.left * s, oy + b.top * s,
                ox + (b.left + b.w) * s, oy + (b.top + b.h) * s);
            boolean active = i == selected;
            c.drawRoundRect(box, 6f, 6f, active ? livePaint : edgePaint);
            if (active) {
                String label = b.name + "  " + b.left + "," + b.top;
                float tw = textPaint.measureText(label);
                float base = box.top - 6f;
                if (base - textPaint.getTextSize() < 0f) base = box.top + textPaint.getTextSize() + 6f;
                c.drawRect(box.left - 1f, base - textPaint.getTextSize() - 3f,
                    box.left + tw + 9f, base + 4f, chipPaint);
                c.drawText(label, box.left + 4f, base, textPaint);
            }
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        float s = scale();
        if (s <= 0f) return false;
        float pad = 10f * getResources().getDisplayMetrics().density;
        float ox = offX(s);
        float oy = offY(s);

        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN: {
                int hit = -1;
                // Front-first: the box drawn last is the one a finger expects.
                for (int i = boxes.size() - 1; i >= 0; i--) {
                    Box b = boxes.get(i);
                    if (!b.enabled || b.w <= 0 || b.h <= 0) continue;
                    float l = ox + b.left * s - pad;
                    float t = oy + b.top * s - pad;
                    float r = ox + (b.left + b.w) * s + pad;
                    float bt = oy + (b.top + b.h) * s + pad;
                    if (e.getX() >= l && e.getX() <= r && e.getY() >= t && e.getY() <= bt) {
                        hit = i;
                        break;
                    }
                }
                selected = hit;
                grabbed = hit;
                if (hit >= 0) {
                    Box b = boxes.get(hit);
                    grabDx = (e.getX() - ox) / s - b.left;
                    grabDy = (e.getY() - oy) / s - b.top;
                    if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(true);
                    if (listener != null) listener.onPick(b.name, b.left, b.top);
                }
                invalidate();
                return true;
            }
            case MotionEvent.ACTION_MOVE: {
                if (grabbed < 0) return true;
                Box b = boxes.get(grabbed);
                int nl = Math.round((e.getX() - ox) / s - grabDx);
                int nt = Math.round((e.getY() - oy) / s - grabDy);
                b.left = Math.max(0, Math.min(canvasW - b.w, nl));
                b.top = Math.max(0, Math.min(canvasH - b.h, nt));
                if (listener != null) listener.onPick(b.name, b.left, b.top);
                invalidate();
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                if (grabbed >= 0) {
                    Box b = boxes.get(grabbed);
                    boolean dropped = e.getActionMasked() == MotionEvent.ACTION_UP;
                    grabbed = -1;
                    if (dropped && listener != null) listener.onDrop(b.id, b.name, b.left, b.top);
                    invalidate();
                }
                grabbed = -1;
                return true;
            }
            default:
                return super.onTouchEvent(e);
        }
    }
}
