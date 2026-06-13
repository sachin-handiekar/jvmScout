package com.example.errdemo.model;

import java.math.BigDecimal;

/** A single order line. */
public class LineItem {
    private final String sku;
    private final BigDecimal unitPrice;
    private final int quantity;

    public LineItem(String sku, BigDecimal unitPrice, int quantity) {
        this.sku = sku;
        this.unitPrice = unitPrice;
        this.quantity = quantity;
    }

    public String getSku() { return sku; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public int getQuantity() { return quantity; }

    public BigDecimal lineTotal() {
        return unitPrice.multiply(BigDecimal.valueOf(quantity));
    }

    @Override
    public String toString() {
        return "LineItem{sku=" + sku + ", unitPrice=" + unitPrice + ", qty=" + quantity + "}";
    }
}
