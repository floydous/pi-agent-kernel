export interface LanguageTestCase {
	lang: string;
	fileName: string;
	code: string;
	expectedSymbol: string;
	expectedKind: string;
}

export const POLYGLOT_CASES: LanguageTestCase[] = [
	{
		lang: "TypeScript",
		fileName: "service.ts",
		code: `export class Guard {\n    public checkReadPrecondition(filePath: string): boolean {\n        return true;\n    }\n}`,
		expectedSymbol: "checkReadPrecondition",
		expectedKind: "method",
	},
	{
		lang: "JavaScript",
		fileName: "calc.js",
		code: `class TaxEngine {\n    computeRate(amount) {\n        return amount * 0.05;\n    }\n}`,
		expectedSymbol: "computeRate",
		expectedKind: "method",
	},
	{
		lang: "Python",
		fileName: "handler.py",
		code: `class ApiHandler:\n    def dispatch_event(self, event):\n        return event.ok()\n`,
		expectedSymbol: "dispatch_event",
		expectedKind: "method",
	},
	{
		lang: "Rust",
		fileName: "state.rs",
		code: `impl CircuitBreaker {\n    pub fn record_failure(&self) -> bool {\n        false\n    }\n}`,
		expectedSymbol: "record_failure",
		expectedKind: "method",
	},
	{
		lang: "Go",
		fileName: "server.go",
		code: `package main\n\ntype Worker struct{}\n\nfunc (w *Worker) StartJob() error {\n    return nil\n}`,
		expectedSymbol: "StartJob",
		expectedKind: "method",
	},
	{
		lang: "C",
		fileName: "buffer.c",
		code: `int parse_packet(char *data, int len) {\n    return len > 0;\n}`,
		expectedSymbol: "parse_packet",
		expectedKind: "function",
	},
	{
		lang: "Cpp",
		fileName: "tokenizer.cpp",
		code: `class Tokenizer {\n    void tokenize_stream() {}\n};`,
		expectedSymbol: "Tokenizer",
		expectedKind: "class",
	},
	{
		lang: "Java",
		fileName: "OrderService.java",
		code: `public class OrderService {\n    public OrderService() {}\n}`,
		expectedSymbol: "OrderService",
		expectedKind: "class",
	},
	{
		lang: "Bash",
		fileName: "deploy.sh",
		code: `function restart_cluster() {\n    echo "cluster restarting"\n}`,
		expectedSymbol: "restart_cluster",
		expectedKind: "function",
	},
	{
		lang: "Ruby",
		fileName: "worker.rb",
		code: `class JobQueue\n    def process_item\n        true\n    end\nend`,
		expectedSymbol: "process_item",
		expectedKind: "method",
	},
	{
		lang: "PHP",
		fileName: "router.php",
		code: `<?php\nclass AppRouter {\n    public function matchRoute() {}\n}`,
		expectedSymbol: "matchRoute",
		expectedKind: "method",
	},
];
