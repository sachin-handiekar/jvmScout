import java.lang.classfile.ClassBuilder;
import java.lang.classfile.ClassElement;
import java.lang.classfile.ClassTransform;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.TypeKind;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.reflect.AccessFlag;
import java.util.ArrayList;
import java.util.List;

/**
 * Class-level transform: forwards every element unchanged except eligible
 * method bodies, which are rewritten via {@link ShadowCodeTransform}.
 */
final class ShadowClassTransform implements ClassTransform {

    static final ClassTransform INSTANCE = new ShadowClassTransform();

    @Override
    public void accept(ClassBuilder clb, ClassElement cle) {
        if (cle instanceof MethodModel mm && eligible(mm)) {
            clb.transformMethod(mm,
                    MethodTransform.transformingCode(new ShadowCodeTransform(paramSlots(mm))));
        } else {
            clb.with(cle);
        }
    }

    private static boolean eligible(MethodModel mm) {
        String name = mm.methodName().stringValue();
        if (name.equals("<clinit>") || name.equals("<init>")) return false;
        var flags = mm.flags();
        return !(flags.has(AccessFlag.NATIVE)
                || flags.has(AccessFlag.ABSTRACT)
                || flags.has(AccessFlag.SYNTHETIC)
                || flags.has(AccessFlag.BRIDGE));
    }

    // Compute initial local-variable slots: `this` (if instance) plus parameters,
    // honouring the two-slot width of long/double.
    private static List<int[]> paramSlots(MethodModel mm) {
        List<int[]> out = new ArrayList<>();
        boolean isStatic = mm.flags().has(AccessFlag.STATIC);
        int slot = 0;
        if (!isStatic) {
            out.add(new int[]{slot, TypeKind.REFERENCE.ordinal()});
            slot += 1;
        }
        MethodTypeDesc mtd = mm.methodTypeSymbol();
        for (ClassDesc p : mtd.parameterList()) {
            TypeKind kind = TypeKind.from(p);
            out.add(new int[]{slot, storeKind(kind).ordinal()});
            slot += kind.slotSize();
        }
        return out;
    }

    // Collapse the fine-grained TypeKind into the coarse store kinds the
    // capture helpers understand (int covers boolean/byte/short/char).
    private static TypeKind storeKind(TypeKind k) {
        return switch (k) {
            case LONG -> TypeKind.LONG;
            case FLOAT -> TypeKind.FLOAT;
            case DOUBLE -> TypeKind.DOUBLE;
            case REFERENCE -> TypeKind.REFERENCE;
            default -> TypeKind.INT;
        };
    }
}
