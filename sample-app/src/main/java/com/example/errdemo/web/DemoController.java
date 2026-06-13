package com.example.errdemo.web;

import com.example.errdemo.model.Order;
import com.example.errdemo.service.OrderService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Endpoints that deliberately trigger exceptions for the JVMTI agent to capture.
 *
 * Note on "caught" vs "uncaught": exceptions thrown from a request handler are
 * caught by Spring's DispatcherServlet (the agent records a catch location, so
 * caught=true) and surface to the client as HTTP 500. The {@code /api/async}
 * endpoint throws on a background thread with no handler, producing a genuinely
 * uncaught exception (caught=false).
 */
@RestController
public class DemoController {

    private static final Logger log = LoggerFactory.getLogger(DemoController.class);

    private final OrderService orderService;

    public DemoController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/")
    public Map<String, String> index() {
        Map<String, String> endpoints = new LinkedHashMap<>();
        endpoints.put("GET /api/npe", "NullPointerException with named locals");
        endpoints.put("GET /api/divide?a=10&b=0", "ArithmeticException (divide by zero)");
        endpoints.put("GET /api/array?index=10", "ArrayIndexOutOfBoundsException");
        endpoints.put("GET /api/parse?value=abc", "NumberFormatException");
        endpoints.put("GET /api/orders/{id}?qty=12", "PricingException with a cause chain + rich locals");
        endpoints.put("GET /api/caught", "Caught + logged (swallowed) exception, returns 200");
        endpoints.put("GET /api/burst?count=60", "Repeated throws to exercise sampling tiers");
        endpoints.put("GET /api/async", "Uncaught exception on a background thread");
        endpoints.put("GET /api/health", "OK, no exception");
        return endpoints;
    }

    @GetMapping("/api/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @GetMapping("/api/npe")
    public String npe() {
        String account = "acct-9001";
        String region = null;
        int regionLen = region.length();   // NPE; account/region/regionLen in scope
        return account + regionLen;
    }

    @GetMapping("/api/divide")
    public Map<String, Object> divide(@RequestParam(defaultValue = "10") int a,
                                      @RequestParam(defaultValue = "0") int b) {
        int quotient = a / b;               // ArithmeticException when b == 0
        return Map.of("a", a, "b", b, "quotient", quotient);
    }

    @GetMapping("/api/array")
    public int array(@RequestParam(defaultValue = "10") int index) {
        int[] inventory = {12, 7, 19, 4, 88};
        int picked = inventory[index];      // ArrayIndexOutOfBoundsException
        return picked;
    }

    @GetMapping("/api/parse")
    public long parse(@RequestParam(defaultValue = "not-a-number") String value) {
        String trimmed = value.trim();
        long parsed = Long.parseLong(trimmed);   // NumberFormatException
        return parsed;
    }

    @GetMapping("/api/orders/{id}")
    public Order order(@PathVariable long id,
                       @RequestParam(defaultValue = "12") int qty) {
        // qty=12 with the demo pricing easily exceeds the credit limit, so this
        // throws PricingException(cause=IllegalStateException) from deep in the
        // service where customer/order/items/subtotal/total are all in scope.
        return orderService.process(id, qty);
    }

    @GetMapping("/api/caught")
    public Map<String, Object> caught() {
        int attempts = 0;
        int swallowed = 0;
        for (int i = 0; i < 3; i++) {
            attempts++;
            try {
                String token = (i % 2 == 0) ? null : "ok";
                token.length();              // NPE on even iterations
            } catch (RuntimeException e) {
                swallowed++;
                log.error("swallowed exception on iteration {}", i, e);
            }
        }
        return Map.of("attempts", attempts, "swallowed", swallowed);
    }

    @GetMapping("/api/burst")
    public Map<String, Object> burst(@RequestParam(defaultValue = "60") int count) {
        int caught = 0;
        for (int i = 0; i < count; i++) {
            try {
                failingOperation(i);
            } catch (RuntimeException e) {
                caught++;
            }
        }
        // Same fingerprint repeated -> watch it demote FULL -> REDUCED -> COUNT_ONLY.
        return Map.of("attempts", count, "caught", caught);
    }

    private void failingOperation(int iteration) {
        Object payload = null;
        payload.toString();                  // NPE, identical site each call
    }

    @GetMapping("/api/async")
    public Map<String, String> async() {
        Thread worker = new Thread(() -> {
            int[] buffer = new int[2];
            int offset = 5;
            int value = buffer[offset];      // uncaught AIOOBE on this thread
            System.out.println(value);
        }, "demo-async-worker");
        worker.setDaemon(true);
        worker.start();
        return Map.of("status", "submitted; an uncaught exception will reach the collector");
    }
}
