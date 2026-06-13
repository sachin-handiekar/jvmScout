package com.example.errdemo.service;

import com.example.errdemo.model.Customer;
import com.example.errdemo.model.LineItem;
import com.example.errdemo.model.Order;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;

/**
 * A multi-level service whose methods hold rich local variables (customer,
 * order, line items, BigDecimal subtotals) at the point an exception is thrown.
 * Ideal for exercising the agent's local-variable + object-graph capture and
 * its cause-chain handling.
 */
@Service
public class OrderService {

    private static final BigDecimal TAX_RATE = new BigDecimal("0.0825");
    private static final BigDecimal VIP_DISCOUNT = new BigDecimal("0.10");

    /**
     * Builds and prices an order. Deliberately throws a {@link PricingException}
     * (wrapping an {@link IllegalStateException} cause) when the computed total
     * exceeds the customer's credit limit — producing a two-deep cause chain.
     */
    public Order process(long orderId, int quantity) {
        if (quantity <= 0) {
            throw new IllegalArgumentException("quantity must be positive, got " + quantity);
        }

        Customer customer = lookupCustomer(orderId);
        Order order = new Order(orderId, customer);
        List<LineItem> items = buildItems(quantity);
        order.setItems(items);

        BigDecimal subtotal = subtotal(items);
        BigDecimal discount = discountFor(customer, subtotal);
        BigDecimal tax = subtotal.subtract(discount).multiply(TAX_RATE).setScale(2, RoundingMode.HALF_UP);
        BigDecimal total = subtotal.subtract(discount).add(tax);
        order.setTotal(total);

        validateCredit(customer, order, total);   // throws when over limit
        return order;
    }

    private Customer lookupCustomer(long orderId) {
        // Derive a deterministic customer from the order id so behaviour is repeatable.
        boolean vip = (orderId % 2L) == 0L;
        String tier = vip ? "vip" : "standard";
        long creditLimit = vip ? 5_000L : 500L;
        return new Customer(orderId, "customer-" + orderId, tier, creditLimit);
    }

    private List<LineItem> buildItems(int quantity) {
        List<LineItem> items = new ArrayList<>();
        BigDecimal unitPrice = new BigDecimal("129.99");
        items.add(new LineItem("WIDGET-PRO", unitPrice, quantity));
        items.add(new LineItem("SHIPPING", new BigDecimal("19.95"), 1));
        return items;
    }

    private BigDecimal subtotal(List<LineItem> items) {
        BigDecimal sum = BigDecimal.ZERO;
        for (LineItem item : items) {
            sum = sum.add(item.lineTotal());
        }
        return sum;
    }

    private BigDecimal discountFor(Customer customer, BigDecimal subtotal) {
        if ("vip".equals(customer.getTier())) {
            return subtotal.multiply(VIP_DISCOUNT).setScale(2, RoundingMode.HALF_UP);
        }
        return BigDecimal.ZERO;
    }

    private void validateCredit(Customer customer, Order order, BigDecimal total) {
        long limit = customer.getCreditLimit();
        if (total.compareTo(BigDecimal.valueOf(limit)) > 0) {
            IllegalStateException cause = new IllegalStateException(
                "total " + total + " exceeds credit limit " + limit);
            throw new PricingException(
                "order " + order.getId() + " rejected for " + customer.getName(), cause);
        }
    }
}
