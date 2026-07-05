import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.Label;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.ArrayLoadInstruction;
import java.lang.classfile.instruction.ArrayStoreInstruction;
import java.lang.classfile.instruction.FieldInstruction;
import java.lang.classfile.instruction.IncrementInstruction;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.LabelTarget;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.classfile.instruction.StoreInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Per-method code transform. Injects:
 *   - {@code __JvmtiShadow.enterMethod()} + parameter capture at method entry;
 *   - capture of known locals before each throw-capable instruction
 *     (invoke, field access, array access);
 *   - {@code __JvmtiShadow.exitMethod()} before each normal return;
 *   - a catch-all region around the whole body that calls
 *     {@code exitMethod()} and rethrows, so the shadow depth counter is also
 *     balanced when the method unwinds exceptionally (previously a leak —
 *     exceptional exits skipped {@code exitMethod}, ratcheting the depth up).
 *
 * <p><b>Verifier soundness.</b> A load the verifier can't prove assigned (or
 * typed) makes the whole class fail to load, so per-site capture is limited to
 * slots whose store appears earlier in the <em>same basic block</em>: the
 * {@code known} map is cleared at every {@link LabelTarget} (all branch
 * targets and exception-handler entries carry a label). A store that precedes
 * the capture with no intervening label dominates it by construction — no
 * dataflow analysis needed. Wide stores additionally invalidate the slot they
 * clobber ({@code long/double} occupy two slots). Parameters are captured at
 * method entry, where they are always definitely assigned. Anything this
 * conservatism misses is still backstopped by BciTransformer's post-transform
 * verify-and-fallback.
 */
final class ShadowCodeTransform implements CodeTransform {

    static final ClassDesc SHADOW = ClassDesc.of("__JvmtiShadow");
    static final MethodTypeDesc MTD_VOID = MethodTypeDesc.ofDescriptor("()V");
    static final MethodTypeDesc MTD_OBJ = MethodTypeDesc.ofDescriptor("(ILjava/lang/Object;)V");
    static final MethodTypeDesc MTD_INT = MethodTypeDesc.ofDescriptor("(II)V");
    static final MethodTypeDesc MTD_LONG = MethodTypeDesc.ofDescriptor("(IJ)V");
    static final MethodTypeDesc MTD_FLOAT = MethodTypeDesc.ofDescriptor("(IF)V");
    static final MethodTypeDesc MTD_DOUBLE = MethodTypeDesc.ofDescriptor("(ID)V");

    // slot -> coarse store kind, in insertion order.
    private final Map<Integer, TypeKind> known = new LinkedHashMap<>();
    private final List<int[]> params;  // {slot, kindOrdinal}

    // Start of the catch-all protected region (bound at method entry).
    private Label tryStart;

    ShadowCodeTransform(List<int[]> params) {
        this.params = params;
        for (int[] p : params) {
            known.put(p[0], TypeKind.values()[p[1]]);
        }
    }

    @Override
    public void atStart(CodeBuilder cb) {
        tryStart = cb.newBoundLabel();
        cb.invokestatic(SHADOW, "enterMethod", MTD_VOID);
        for (int[] p : params) {
            emitCapture(cb, p[0], TypeKind.values()[p[1]]);
        }
    }

    @Override
    public void atEnd(CodeBuilder cb) {
        // Protect the whole original body: on any exception that unwinds out of
        // this method, pop the shadow frame (balancing enterMethod) and rethrow.
        Label tryEnd = cb.newBoundLabel();
        Label handler = cb.newLabel();
        cb.exceptionCatchAll(tryStart, tryEnd, handler);
        cb.labelBinding(handler);            // handler entry: Throwable is on the stack
        cb.invokestatic(SHADOW, "exitMethod", MTD_VOID);
        cb.athrow();                          // rethrow the in-flight Throwable
    }

    @Override
    public void accept(CodeBuilder cb, CodeElement e) {
        if (e instanceof LabelTarget) {
            // Basic-block boundary (branch target / handler entry): stores seen
            // so far no longer dominate what follows. Forget them.
            known.clear();
            cb.with(e);
            return;
        }
        if (e instanceof StoreInstruction si) {
            cb.with(e);
            recordStore(si.slot(), si.typeKind());
            return;
        }
        if (e instanceof IncrementInstruction inc) {
            // iinc proves the slot holds an int here.
            cb.with(e);
            recordStore(inc.slot(), TypeKind.INT);
            return;
        }
        if (e instanceof ReturnInstruction) {
            cb.invokestatic(SHADOW, "exitMethod", MTD_VOID);
            cb.with(e);
            return;
        }
        if (isThrowCapable(e)) {
            for (Map.Entry<Integer, TypeKind> en : known.entrySet()) {
                emitCapture(cb, en.getKey(), en.getValue());
            }
        }
        cb.with(e);
    }

    // Track a definite assignment at this point in the current block, keeping
    // two-slot (long/double) bookkeeping consistent: a wide store clobbers the
    // next slot, and any store clobbers the high half of a wide value at n-1.
    private void recordStore(int slot, TypeKind kind) {
        TypeKind below = known.get(slot - 1);
        if (below == TypeKind.LONG || below == TypeKind.DOUBLE) {
            known.remove(slot - 1);  // overwrote the wide value's high half
        }
        if (kind == TypeKind.LONG || kind == TypeKind.DOUBLE) {
            known.remove(slot + 1);  // wide store occupies slot and slot+1
        }
        known.put(slot, kind);
    }

    private static boolean isThrowCapable(CodeElement e) {
        return e instanceof InvokeInstruction
                || e instanceof FieldInstruction
                || e instanceof ArrayLoadInstruction
                || e instanceof ArrayStoreInstruction;
    }

    private static void emitCapture(CodeBuilder cb, int slot, TypeKind kind) {
        cb.loadConstant(slot);
        switch (kind) {
            case REFERENCE -> { cb.aload(slot); cb.invokestatic(SHADOW, "captureObject", MTD_OBJ); }
            case LONG      -> { cb.lload(slot); cb.invokestatic(SHADOW, "captureLong", MTD_LONG); }
            case FLOAT     -> { cb.fload(slot); cb.invokestatic(SHADOW, "captureFloat", MTD_FLOAT); }
            case DOUBLE    -> { cb.dload(slot); cb.invokestatic(SHADOW, "captureDouble", MTD_DOUBLE); }
            default        -> { cb.iload(slot); cb.invokestatic(SHADOW, "captureInt", MTD_INT); }
        }
    }
}
