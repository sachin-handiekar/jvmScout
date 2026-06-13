package com.example.errdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Spring Boot test application for the JVMTI exception-monitoring agent.
 *
 * Run it with the agent attached (see sample-app/README.md), then hit the
 * endpoints in {@code DemoController} to generate caught, uncaught, nested, and
 * variable-rich exceptions that the agent captures and forwards to the collector.
 */
@SpringBootApplication
public class ErrorDemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(ErrorDemoApplication.class, args);
    }
}
