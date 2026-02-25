import fs from "node:fs";
import path from "node:path";
import { LogLevelWeight, type LogLevel } from "./levels.js";

type LoggerOptions = {
  level?: LogLevel;
  logDir?: string;
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: "\u001b[90m",
  INFO: "\u001b[97m",
  WARN: "\u001b[33m",
  ERROR: "\u001b[31m",
  TRADE: "\u001b[34m",
};

const RESET_COLOR = "\u001b[0m";

class Logger {
  private static initialized = false;
  private static fileStream: fs.WriteStream | null = null;
  private static level: LogLevel = "DEBUG";
  private static logDir: string = path.resolve(process.cwd(), "logs");
  private static logFilePath: string | null = null;
  private moduleName: string;

  constructor(moduleName: string, options?: LoggerOptions) {
    this.moduleName = moduleName;
    if (options?.level) {
      Logger.level = options.level;
    }
    if (options?.logDir) {
      Logger.logDir = path.resolve(options.logDir);
    }
    Logger.ensureInitialized();
  }

  setLevel(level: LogLevel): void {
    Logger.level = level;
  }

  close(): void {
    Logger.fileStream?.end();
    Logger.fileStream = null;
    Logger.initialized = false;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("DEBUG", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("INFO", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("WARN", message, meta);
  }

  error(message: string, error?: unknown): void {
    const meta = error ? { error: this.formatError(error) } : undefined;
    this.write("ERROR", message, meta);
  }

  trade(message: string, meta?: Record<string, unknown>): void {
    this.write("TRADE", message, meta);
  }

  private static ensureInitialized(): void {
    if (Logger.initialized) {
      return;
    }

    fs.mkdirSync(Logger.logDir, { recursive: true });
    const fileName = Logger.createFileName(new Date());
    Logger.logFilePath = path.join(Logger.logDir, fileName);
    Logger.fileStream = fs.createWriteStream(Logger.logFilePath, { flags: "a" });
    Logger.initialized = true;
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    Logger.ensureInitialized();
    const timestamp = new Date().toISOString();
    const metaText = meta ? ` ${this.safeStringify(meta)}` : "";
    const line = `[${timestamp}] [${level}] [${this.moduleName}] ${message}${metaText}`;
    Logger.fileStream?.write(`${line}\n`);

    const color = LEVEL_COLORS[level];
    const coloredLine = `${color}${line}${RESET_COLOR}`;
    if (level === "ERROR") {
      console.error(coloredLine);
    } else {
      console.log(coloredLine);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LogLevelWeight[level] >= LogLevelWeight[Logger.level];
  }

  private safeStringify(meta: Record<string, unknown>): string {
    try {
      return JSON.stringify(meta);
    } catch (error) {
      return JSON.stringify({ error: "日志元数据序列化失败" });
    }
  }

  private formatError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return { message: String(error) };
  }

  private static createFileName(date: Date): string {
    const pad = (value: number): string => value.toString().padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());
    const second = pad(date.getSeconds());
    return `bot_${year}-${month}-${day}_${hour}-${minute}-${second}.log`;
  }
}

export { Logger, type LoggerOptions };
