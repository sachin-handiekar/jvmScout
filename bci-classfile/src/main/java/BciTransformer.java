import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;

/**
 * JNI entry point for the native agent's CLASS_FILE_LOAD_HOOK. Rewrites
 * eligible classes to inject shadow local-variable capture, using the JDK
 * {@code java.lang.classfile} API (JEP 484, final in JDK 24).
 *
 * <p>Contract: returns the instrumented bytes, or {@code null} to leave the
 * class unchanged. Never throws — any failure returns {@code null}.
 */
public final class BciTransformer {

    // Packages never instrumented: JDK internals, common frameworks, and the
    // agent's own infrastructure (avoids recursion during bootstrap).
    private static final String[] EXCLUDE = {
        "java/", "javax/", "jdk/", "sun/", "com/sun/",
        "org/springframework/", "org/apache/", "ch/qos/logback/",
        "org/slf4j/", "io/netty/", "kotlin/", "scala/",
        "__JvmtiShadow", "BciTransformer", "ShadowClassTransform", "ShadowCodeTransform",
    };

    private BciTransformer() {}

    public static byte[] transform(String className, byte[] classFileBuffer) {
        try {
            if (className == null || classFileBuffer == null) return null;
            if (isExcluded(className)) return null;

            ClassFile cf = ClassFile.of();
            ClassModel model = cf.parse(classFileBuffer);
            return cf.transformClass(model, ShadowClassTransform.INSTANCE);
        } catch (Throwable t) {
            // A throwing transformer would be silently dropped by the JVM anyway;
            // returning null explicitly leaves the original bytecode in place.
            return null;
        }
    }

    private static boolean isExcluded(String className) {
        for (String p : EXCLUDE) {
            if (className.startsWith(p)) return true;
        }
        return false;
    }
}
