export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export type LogOutputFormat = "plain" | "json";

export interface LoggerConfig {
  enabled: boolean;
  level: LogLevel;
  outputFormat: LogOutputFormat;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  metadata: {
    sessionId: string;
    extensionVersion: string;
    vscodeVersion: string;
    platform: string;
    nodeVersion: string;
    fileName?: string;
    lineNumber?: number;
  };
}

export interface Transport {
  log(entry: LogEntry): void;
  dispose(): void;
}

export interface LogPoint {
  name: string;
  startTime: number;
}

export interface PerformanceMetrics {
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
}
