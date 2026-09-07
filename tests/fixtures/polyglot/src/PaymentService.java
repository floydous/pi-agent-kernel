// Java fixture: complex service with multiple inner classes, generics, and synchronized methods.
package com.demo;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import java.util.Optional;

public class PaymentService {

    public enum Currency {
        USD, EUR, GBP, JPY
    }

    public static final int MAX_RETRIES = 3;
    public static final Currency DEFAULT_CURRENCY = Currency.USD;

    private final Map<String, Double> balances = new ConcurrentHashMap<>();
    private volatile boolean shutdown = false;

    public PaymentService() {
        // Default balances for testing.
        balances.put("default", 1000.0);
    }

    public synchronized boolean commit(long txId) {
        if (shutdown) {
            return false;
        }
        return balances.getOrDefault("default", 0.0) >= 0.0;
    }

    public synchronized Optional<Double> refund(long txId, double amount) {
        if (amount <= 0.0) {
            return Optional.empty();
        }
        Double balance = balances.get("default");
        if (balance == null || balance < amount) {
            return Optional.empty();
        }
        balances.put("default", balance - amount);
        return Optional.of(amount);
    }

    public CompletableFuture<Void> rollbackAsync(long txId) {
        return CompletableFuture.runAsync(() -> {
            try {
                Thread.sleep(10);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        });
    }

    public void shutdown() {
        this.shutdown = true;
    }

    public double getBalance(String account) {
        return balances.getOrDefault(account, 0.0);
    }
}
