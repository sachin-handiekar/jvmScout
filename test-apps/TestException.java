/**
 * Minimal harness that deterministically triggers three exception scenarios for
 * end-to-end validation of the JVMTI agent. Compile with -g so the agent can
 * read local variable names/values from the Local Variable Table:
 *
 *   javac -g TestException.java
 *   java -agentpath:../agent/jvmti-agent.dll=host=localhost,port=8080 TestException
 */
public class TestException {

    public static void main(String[] args) throws Exception {
        System.out.println("[test] starting exception scenarios");

        runQuietly("NullPointer", TestException::testNullPointer);
        runQuietly("ArrayBounds", TestException::testArrayBounds);
        runQuietly("WithObjects", TestException::testWithObjects);

        // A burst to exercise the sampling tiers (FULL -> REDUCED -> COUNT_ONLY).
        for (int i = 0; i < 50; i++) {
            runQuietly("Burst", TestException::testNullPointer);
        }

        // Give the agent's async transport time to flush before the JVM exits.
        Thread.sleep(3000);
        System.out.println("[test] done");
    }

    private interface Scenario { void run(); }

    private static void runQuietly(String label, Scenario s) {
        try {
            s.run();
        } catch (Throwable t) {
            System.out.println("[test] " + label + " -> " + t.getClass().getSimpleName());
        }
    }

    private static void testNullPointer() {
        String nullString = null;
        int length = nullString.length();   // NPE
        System.out.println(length);
    }

    private static void testArrayBounds() {
        int[] numbers = {1, 2, 3, 4, 5};
        int index = 10;
        int value = numbers[index];          // ArrayIndexOutOfBoundsException
        System.out.println(value);
    }

    private static void testWithObjects() {
        int userId = 42;
        String userName = "alice";
        Person person = new Person(userName, null);
        // Dereferencing the null address verifies object-graph + local capture:
        // at the throw site, userId/userName/person are all in scope.
        int zip = person.address.zipCode;    // NPE (address is null)
        System.out.println(zip);
    }

    static final class Person {
        final String name;
        final Address address;
        Person(String name, Address address) {
            this.name = name;
            this.address = address;
        }
    }

    static final class Address {
        int zipCode;
    }
}
