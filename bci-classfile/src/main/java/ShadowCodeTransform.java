import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.ArrayLoadInstruction;
import java.lang.classfile.instruction.ArrayStoreInstruction;
import java.lang.classfile.instruction.FieldInstruction;
import java.lang.classfile.instruction.InvokeInstruction;
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
 *   - capture of all known (stored) locals before each throw-capable
 *     instruction (invoke, field access, array access);
 *   - {@code __JvmtiShadow.exitMethod()} before each normal return.
 *
 * Known slots are learned by watching store instructions, mirroring the
 * "all-visible-locals" capture described in the design notes.
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

    ShadowCodeTransform(List<int[]> params) {
        this.params = params;
        for (int[] p : params) {
            known.put(p[0], TypeKind.values()[p[1]]);
        }
    }

    @Override
    public void atStart(CodeBuilder cb) {
        cb.invokestatic(SHADOW, "enterMethod", MTD_VOID);
        for (int[] p : params) {
            emitCapture(cb, p[0], TypeKind.values()[p[1]]);
        }
    }

    @Override
    public void accept(CodeBuilder cb, CodeElement e) {
        if (e instanceof StoreInstruction si) {
            cb.with(e);
            known.put(si.slot(), si.typeKind());
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
