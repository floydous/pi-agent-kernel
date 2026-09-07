// Polyglot code fixtures for multi-language testing
export const POLYGLOT_FIXTURES: Record<string, string> = {
	"src/app.ts": `
export interface ServerConfig {
    port: number;
    host: string;
}

export class AppServer {
    private _active: boolean = false;

    get isActive(): boolean {
        return this._active;
    }

    public async start(cfg: ServerConfig): Promise<void> {
        this._active = true;
    }
}
`,
	"src/worker.rs": `
pub struct TaskWorker {
    pub worker_id: u32,
}

impl TaskWorker {
    pub unsafe fn spawn_raw(id: u32) -> *mut TaskWorker {
        std::ptr::null_mut()
    }

    pub async fn process_job(&self, job_name: &str) -> Result<(), String> {
        Ok(())
    }
}
`,
	"src/router.go": `
package router

type ServiceHandler interface {
    ServeRequest(path string) bool
}

func InitRouter(name string) ServiceHandler {
    return nil
}
`,
	"src/PaymentService.java": `
package com.demo;

public class PaymentService {
    public void executeTransaction(double amount) {
        System.out.println("Processing: " + amount);
    }
}
`,
	"src/OrderProcessor.cs": `
namespace Demo.App
{
    public class OrderProcessor
    {
        public async Task<bool> ProcessOrderAsync(string orderId)
        {
            return true;
        }
    }
}
`,
	"src/checksum.c": `
#include <stdio.h>

int compute_checksum(const char *data, int len) {
    return 42;
}
`,
	"src/solver.cpp": `
#include <string>

class GeometrySolver {
public:
    double calculate_hypotenuse(double a, double b) {
        return 5.0;
    }
};
`,
	"src/report.rb": `
class ReportGenerator
  def generate_summary(records)
    records.length
  end
end
`,
	"src/CacheManager.php": `
<?php
namespace App\\Services;

class CacheManager {
    public static function flushAll(): bool {
        return true;
    }
}
`,
	"src/deploy.sh": `
#!/usr/bin/env bash

deploy_cluster() {
    local env_name="$1"
    echo "Deploying to $env_name"
}
`,
};
