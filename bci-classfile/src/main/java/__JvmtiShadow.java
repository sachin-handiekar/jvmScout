import java.util.Arrays;

/**
 * Bootstrap-visible shadow store for local-variable capture. Instrumented
 * application methods push a frame on entry, write their locals as they go, and
 * pop on return. The native agent reads frames back at exception time for code
 * compiled without {@code -g}.
 *
 * <p>Default package + simple name so the native agent can {@code FindClass}
 * it. All write methods are {@code Throwable}-guarded: instrumentation must
 * never break the host application.
 *
 * <p>Depth model: {@code getFrame(depth)} takes a <em>native stack depth</em>
 * (0 = current/top frame). Both normal returns and exceptional unwinds run
 * {@code exitMethod} (the transform wraps each instrumented body in a catch-all
 * that pops and rethrows), so the depth counter stays balanced rather than
 * ratcheting up across caught exceptions.
 */
public final class __JvmtiShadow {

    private static final int MAX_DEPTH = 64;
    private static final int MAX_SLOTS = 32;

    private static final ThreadLocal<int[]> DEPTH =
            ThreadLocal.withInitial(() -> new int[]{-1});
    private static final ThreadLocal<Object[][]> FRAMES =
            ThreadLocal.withInitial(() -> new Object[MAX_DEPTH][MAX_SLOTS]);
    private static final ThreadLocal<String[][]> NAMES =
            ThreadLocal.withInitial(() -> new String[MAX_DEPTH][MAX_SLOTS]);
    private static final ThreadLocal<int[][]> SLOT_TYPES =
            ThreadLocal.withInitial(() -> new int[MAX_DEPTH][MAX_SLOTS]);

    private __JvmtiShadow() {}

    public static void enterMethod() {
        try {
            int[] d = DEPTH.get();
            if (d[0] < MAX_DEPTH - 1) {
                d[0]++;
                Arrays.fill(FRAMES.get()[d[0]], null);
                Arrays.fill(NAMES.get()[d[0]], null);
                Arrays.fill(SLOT_TYPES.get()[d[0]], 0);
            }
        } catch (Throwable ignored) {}
    }

    public static void exitMethod() {
        try {
            int[] d = DEPTH.get();
            if (d[0] >= 0) d[0]--;
        } catch (Throwable ignored) {}
    }

    public static void captureObject(int slot, Object v) { write(slot, v, 1); }
    public static void captureInt(int slot, int v)       { write(slot, Integer.valueOf(v), 2); }
    public static void captureLong(int slot, long v)     { write(slot, Long.valueOf(v), 3); }
    public static void captureFloat(int slot, float v)   { write(slot, Float.valueOf(v), 4); }
    public static void captureDouble(int slot, double v) { write(slot, Double.valueOf(v), 5); }

    public static void setSlotMetadata(int slot, String name) {
        try {
            int d = DEPTH.get()[0];
            if (valid(d, slot)) NAMES.get()[d][slot] = name;
        } catch (Throwable ignored) {}
    }

    private static void write(int slot, Object v, int type) {
        try {
            int d = DEPTH.get()[0];
            if (valid(d, slot)) {
                FRAMES.get()[d][slot] = v;
                SLOT_TYPES.get()[d][slot] = type;
            }
        } catch (Throwable ignored) {}
    }

    private static boolean valid(int d, int slot) {
        return d >= 0 && d < MAX_DEPTH && slot >= 0 && slot < MAX_SLOTS;
    }

    // ----- native read API (depth = native stack depth, 0 = current top) -----

    public static Object[] getFrame(int depth) {
        try {
            int d = DEPTH.get()[0] - depth;
            if (d >= 0 && d < MAX_DEPTH) return FRAMES.get()[d];
        } catch (Throwable ignored) {}
        return null;
    }

    public static String[] getMetadata(int depth) {
        try {
            int d = DEPTH.get()[0] - depth;
            if (d >= 0 && d < MAX_DEPTH) return NAMES.get()[d];
        } catch (Throwable ignored) {}
        return null;
    }

    public static int[] getSlotTypes(int depth) {
        try {
            int d = DEPTH.get()[0] - depth;
            if (d >= 0 && d < MAX_DEPTH) return SLOT_TYPES.get()[d];
        } catch (Throwable ignored) {}
        return null;
    }

    public static void clearFrame(int depth) {
        try {
            int d = DEPTH.get()[0] - depth;
            if (d >= 0 && d < MAX_DEPTH) {
                Arrays.fill(FRAMES.get()[d], null);
                Arrays.fill(NAMES.get()[d], null);
            }
        } catch (Throwable ignored) {}
    }
}
