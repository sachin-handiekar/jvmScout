package com.example.errdemo.model;

import java.math.BigDecimal;
import java.util.List;

/** An order aggregating line items for a customer. */
public class Order {
    private final long id;
    private final Customer customer;
    private List<LineItem> items;
    private BigDecimal total;

    public Order(long id, Customer customer) {
        this.id = id;
        this.customer = customer;
    }

    public long getId() { return id; }
    public Customer getCustomer() { return customer; }
    public List<LineItem> getItems() { return items; }
    public void setItems(List<LineItem> items) { this.items = items; }
    public BigDecimal getTotal() { return total; }
    public void setTotal(BigDecimal total) { this.total = total; }

    @Override
    public String toString() {
        return "Order{id=" + id + ", customer=" + customer + ", total=" + total + "}";
    }
}
