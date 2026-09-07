export const JAVA_COMPLEX_CODE = `
package com.kernel.service;

import java.util.concurrent.CompletableFuture;

public class TransactionCoordinator {
    public static final int MAX_RETRIES = 3;

    public synchronized boolean commit(long txId) {
        return true;
    }

    public CompletableFuture<Void> rollbackAsync(long txId) {
        return CompletableFuture.completedFuture(null);
    }
}
`;
