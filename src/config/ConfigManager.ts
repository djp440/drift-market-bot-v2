import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import toml from "@iarna/toml";
import { validateConfig, type Config } from "./schema.js";
import { Logger } from "../logger/Logger.js";

type ConfigManagerOptions = {
  configPath?: string;
  logger?: Logger;
};

class ConfigManager extends EventEmitter {
  private static instance: ConfigManager | null = null;
  private config: Config | null = null;
  private configPath: string;
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private logger: Logger | null = null;

  private constructor(options?: ConfigManagerOptions) {
    super();
    this.configPath = path.resolve(options?.configPath ?? "config.toml");
    this.logger = options?.logger ?? null;
  }

  static getInstance(options?: ConfigManagerOptions): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager(options);
      return ConfigManager.instance;
    }

    if (options?.configPath && path.resolve(options.configPath) !== ConfigManager.instance.configPath) {
      throw new Error("ConfigManager 已初始化，configPath 不一致");
    }

    if (options?.logger) {
      ConfigManager.instance.logger = options.logger;
    }

    return ConfigManager.instance;
  }

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  async load(): Promise<Config> {
    const content = await fsPromises.readFile(this.configPath, "utf-8");
    const parsed = toml.parse(content) as Config;
    this.validate(parsed);
    this.config = parsed;
    return this.get();
  }

  validate(config: Config): void {
    validateConfig(config);
  }

  get(): Config {
    if (!this.config) {
      throw new Error("配置尚未加载");
    }

    return structuredClone(this.config);
  }

  update(newConfig: Config): void {
    this.validate(newConfig);
    this.config = structuredClone(newConfig);
    this.emit("configUpdated", this.get());
  }

  watch(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = fs.watch(this.configPath, (eventType) => {
      if (eventType !== "change" && eventType !== "rename") {
        return;
      }

      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
      }

      this.reloadTimer = setTimeout(async () => {
        try {
          const updatedConfig = await this.load();
          this.emit("configUpdated", updatedConfig);
          this.logger?.info("配置文件已热重载", { configPath: this.configPath });
        } catch (error) {
          this.logger?.error("配置热重载失败", error);
          this.emit("configError", error);
        }
      }, 200);
    });
  }
}

export { ConfigManager, type ConfigManagerOptions };
