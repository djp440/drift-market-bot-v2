type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "TRADE";

const LogLevelWeight: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  TRADE: 25,
  WARN: 30,
  ERROR: 40,
};

export type { LogLevel };
export { LogLevelWeight };
