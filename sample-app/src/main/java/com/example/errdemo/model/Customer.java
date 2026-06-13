package com.example.errdemo.model;

/** A customer with a loyalty tier — supplies object-graph locals for capture. */
public class Customer {
    private final long id;
    private final String name;
    private final String tier;       // "standard" | "vip"
    private final long creditLimit;

    public Customer(long id, String name, String tier, long creditLimit) {
        this.id = id;
        this.name = name;
        this.tier = tier;
        this.creditLimit = creditLimit;
    }

    public long getId() { return id; }
    public String getName() { return name; }
    public String getTier() { return tier; }
    public long getCreditLimit() { return creditLimit; }

    @Override
    public String toString() {
        return "Customer{id=" + id + ", name=" + name + ", tier=" + tier + "}";
    }
}
