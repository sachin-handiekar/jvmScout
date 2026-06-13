package com.example.errdemo.service;

/** Domain exception thrown by {@link OrderService} when pricing rules fail. */
public class PricingException extends RuntimeException {
    public PricingException(String message, Throwable cause) {
        super(message, cause);
    }
}
