import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_CONFIG_FILE = ".commitgen.json";
export const DEFAULT_MODEL = "gpt-oss:120b-cloud";
export const DEFAULT_HOST = "http://localhost:11434";
export const DEFAULT_MAX_CHARS = 16000;
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_TICKET_PATTERN = "([A-Z][A-Z0-9]+-\\d+)";
export const DEFAULT_HISTORY_ENABLED = true;
export const DEFAULT_HISTORY_SAMPLE_SIZE = 5;
export const DEFAULT_INTERACTIVE_CANDIDATES = 3;

export type RepoConfig = {
    model?: string;
    host?: string;
    maxChars?: number;
    defaultScope?: string;
    scopes?: string[];
    ticketPattern?: string;
    historyEnabled?: boolean;
    historySampleSize?: number;
    interactiveCandidates?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expectOptionalString(
    value: unknown,
    key: keyof RepoConfig
): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new Error(`Config field "${key}" must be a string.`);
    }

    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`Config field "${key}" must not be empty.`);
    }

    return normalized;
}

function expectOptionalInteger(
    value: unknown,
    key: keyof RepoConfig
): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value)) {
        throw new Error(`Config field "${key}" must be an integer.`);
    }
    return value as number;
}

function expectOptionalBoolean(
    value: unknown,
    key: keyof RepoConfig
): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
        throw new Error(`Config field "${key}" must be a boolean.`);
    }
    return value;
}

function expectOptionalStringArray(
    value: unknown,
    key: keyof RepoConfig
): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`Config field "${key}" must be an array of strings.`);
    }

    return value.map((entry) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
            throw new Error(`Config field "${key}" must contain only non-empty strings.`);
        }
        return entry.trim();
    });
}

function parseRepoConfig(input: unknown): RepoConfig {
    if (!isRecord(input)) {
        throw new Error("Config file must contain a JSON object.");
    }

    const config: RepoConfig = {
        model: expectOptionalString(input.model, "model"),
        host: expectOptionalString(input.host, "host"),
        maxChars: expectOptionalInteger(input.maxChars, "maxChars"),
        defaultScope: expectOptionalString(input.defaultScope, "defaultScope"),
        scopes: expectOptionalStringArray(input.scopes, "scopes"),
        ticketPattern: expectOptionalString(input.ticketPattern, "ticketPattern"),
        historyEnabled: expectOptionalBoolean(input.historyEnabled, "historyEnabled"),
        historySampleSize: expectOptionalInteger(input.historySampleSize, "historySampleSize"),
        interactiveCandidates: expectOptionalInteger(input.interactiveCandidates, "interactiveCandidates")
    };

    if (config.ticketPattern) {
        try {
            new RegExp(config.ticketPattern);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Config field "ticketPattern" is not a valid regular expression: ${message}`);
        }
    }

    return config;
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

export async function loadRepoConfig(repoRoot: string, configPath: string | null): Promise<RepoConfig> {
    const targetPath = configPath
        ? resolve(process.cwd(), configPath)
        : join(repoRoot, DEFAULT_CONFIG_FILE);

    const exists = await fileExists(targetPath);
    if (!exists) {
        if (configPath) {
            throw new Error(`Config file not found: ${targetPath}`);
        }
        return {};
    }

    let raw: string;
    try {
        raw = await readFile(targetPath, "utf8");
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read config file "${targetPath}": ${message}`);
    }

    try {
        return parseRepoConfig(JSON.parse(raw));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid config file "${targetPath}": ${message}`);
    }
}
