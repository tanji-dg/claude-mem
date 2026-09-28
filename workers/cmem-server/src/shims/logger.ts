// SPDX-License-Identifier: Apache-2.0
//
// Worker replacement for src/utils/logger.ts (swapped in by build/aliases.mjs).
// The original writes to ~/.claude-mem/logs via fs and reads settings.json at
// runtime; neither exists on Workers. This keeps the same exported API surface
// that reused repo modules call, and routes everything to console (captured by
// Workers Logs / `wrangler tail`).

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	SILENT = 4,
}

// The original is a closed string union; any string is fine for console output.
export type Component = string;

interface LogContext {
	[key: string]: unknown;
}

export type ErrorSink = (err: unknown, ctx?: Record<string, unknown>) => void;

function serializeData(data: unknown): unknown {
	if (data instanceof Error) {
		return { name: data.name, message: data.message, stack: data.stack };
	}
	return data;
}

class WorkerLogger {
	private level: LogLevel = LogLevel.INFO;
	private errorSink: ErrorSink | null = null;

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	setErrorSink(sink: ErrorSink | null): void {
		this.errorSink = sink;
	}

	formatTool(toolName: string, toolInput?: unknown): string {
		if (toolInput === undefined) return toolName;
		try {
			const text = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
			return `${toolName}(${text.length > 80 ? `${text.slice(0, 77)}...` : text})`;
		} catch {
			return toolName;
		}
	}

	private emit(level: LogLevel, tag: string, component: Component, message: string, context?: LogContext, data?: unknown): void {
		if (level < this.level) return;
		const line: Record<string, unknown> = { level: tag, component, message };
		if (context && Object.keys(context).length > 0) line.context = context;
		if (data !== undefined) line.data = serializeData(data);
		const fn = level >= LogLevel.ERROR ? console.error : level === LogLevel.WARN ? console.warn : console.log;
		fn(JSON.stringify(line));
	}

	debug(component: Component, message: string, context?: LogContext, data?: unknown): void {
		this.emit(LogLevel.DEBUG, 'DEBUG', component, message, context, data);
	}

	info(component: Component, message: string, context?: LogContext, data?: unknown): void {
		this.emit(LogLevel.INFO, 'INFO', component, message, context, data);
	}

	warn(component: Component, message: string, context?: LogContext, data?: unknown): void {
		this.emit(LogLevel.WARN, 'WARN', component, message, context, data);
	}

	error(component: Component, message: string, context?: LogContext, data?: unknown): void {
		this.emit(LogLevel.ERROR, 'ERROR', component, message, context, data);
		if (this.errorSink && data instanceof Error) {
			try {
				this.errorSink(data, { component, message, ...context });
			} catch {
				// the sink is best-effort by contract
			}
		}
	}

	dataIn(component: Component, message: string, context?: LogContext, data?: unknown): void {
		this.emit(LogLevel.INFO, 'IN', component, message, context, data);
	}

	dataOut(component: Component, message: string, context?: LogContext, data?: unknown): void {
		this.emit(LogLevel.INFO, 'OUT', component, message, context, data);
	}

	success(component: Component, message: string, context?: LogContext, data?: unknown): void {
		this.emit(LogLevel.INFO, 'SUCCESS', component, message, context, data);
	}

	failure(component: Component, message: string, context?: LogContext, data?: unknown): void {
		this.error(component, message, context, data);
	}
}

export const logger = new WorkerLogger();
