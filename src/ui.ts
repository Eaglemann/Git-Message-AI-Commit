import type { CandidateDiagnostics, ContextDiagnostics, DiagnosticSource } from "./diagnostics.js";
import type { DoctorCheck, DoctorResult } from "./doctor.js";

type TerminalStream = {
    isTTY?: boolean;
    columns?: number;
};

type Tone = "accent" | "danger" | "muted" | "success" | "warning";

type GlyphSet = {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
    dividerLeft: string;
    dividerRight: string;
    separator: string;
    bullet: string;
    ok: string;
    fail: string;
};

type CardTone = Exclude<Tone, "muted">;

export type TerminalUi = {
    richLayout: boolean;
    color: boolean;
    unicode: boolean;
    width: number;
    glyphs: GlyphSet;
};

const ANSI = {
    reset: "\u001b[0m",
    bold: "\u001b[1m",
    dim: "\u001b[2m",
    red: "\u001b[31m",
    green: "\u001b[32m",
    yellow: "\u001b[33m",
    cyan: "\u001b[36m"
} as const;

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

const UNICODE_GLYPHS: GlyphSet = {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    dividerLeft: "├",
    dividerRight: "┤",
    separator: "·",
    bullet: "•",
    ok: "✓",
    fail: "✕"
};

const ASCII_GLYPHS: GlyphSet = {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    dividerLeft: "+",
    dividerRight: "+",
    separator: "|",
    bullet: "-",
    ok: "OK",
    fail: "X"
};

function clampWidth(columns: number | undefined): number {
    const fallback = 88;
    if (!columns || !Number.isFinite(columns)) return fallback;
    return Math.max(64, Math.min(100, Math.floor(columns)));
}

function detectUnicodeSupport(stream: TerminalStream | undefined): boolean {
    if (process.env.TERM === "dumb") return false;
    if (process.platform !== "win32") return true;
    return Boolean(
        process.env.WT_SESSION
        || process.env.TERM_PROGRAM
        || process.env.ConEmuANSI === "ON"
        || process.env.ANSICON
        || stream?.isTTY
    );
}

function paint(ui: TerminalUi, text: string, ...codes: string[]): string {
    if (!ui.color || codes.length === 0) return text;
    return `${codes.join("")}${text}${ANSI.reset}`;
}

function tone(ui: TerminalUi, value: string, color: Tone): string {
    switch (color) {
        case "accent":
            return paint(ui, value, ANSI.bold, ANSI.cyan);
        case "danger":
            return paint(ui, value, ANSI.bold, ANSI.red);
        case "muted":
            return paint(ui, value, ANSI.dim);
        case "success":
            return paint(ui, value, ANSI.bold, ANSI.green);
        case "warning":
            return paint(ui, value, ANSI.bold, ANSI.yellow);
        default:
            return value;
    }
}

function stripAnsi(value: string): string {
    return value.replace(ANSI_PATTERN, "");
}

function visibleLength(value: string): number {
    return stripAnsi(value).length;
}

function padVisible(value: string, width: number): string {
    const padding = Math.max(0, width - visibleLength(value));
    return `${value}${" ".repeat(padding)}`;
}

function wrapLine(line: string, width: number): string[] {
    const normalized = line.trim();
    if (!normalized) return [""];
    if (visibleLength(normalized) <= width) return [normalized];

    const words = normalized.split(/\s+/);
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        if (!current) {
            current = word;
            continue;
        }

        if (visibleLength(`${current} ${word}`) <= width) {
            current = `${current} ${word}`;
            continue;
        }

        lines.push(current);
        current = word;
    }

    if (current) lines.push(current);
    return lines;
}

function compactSource(source: DiagnosticSource): string {
    switch (source) {
        case "cli":
            return "cli";
        case "diff":
            return "diff";
        case "changed-files":
            return "files";
        case "default-config":
            return "default";
        case "branch":
            return "branch";
        case "message":
            return "message";
        default:
            return "none";
    }
}

function formatMetaLine(ui: TerminalUi, items: Array<string | null | undefined>): string {
    return items
        .filter((item): item is string => Boolean(item))
        .join(` ${ui.glyphs.separator} `);
}

function border(ui: TerminalUi, left: string, right: string, width: number): string {
    return `${left}${ui.glyphs.horizontal.repeat(width - 2)}${right}`;
}

function row(ui: TerminalUi, content: string, innerWidth: number): string {
    return `${ui.glyphs.vertical} ${padVisible(content, innerWidth)} ${ui.glyphs.vertical}`;
}

function renderCard(
    ui: TerminalUi,
    title: string,
    lines: string[],
    toneName: CardTone = "accent"
): string {
    if (!ui.richLayout) {
        return [title, ...lines].join("\n");
    }

    const innerWidth = Math.max(24, ui.width - 4);
    const out = [
        border(ui, ui.glyphs.topLeft, ui.glyphs.topRight, innerWidth + 4),
        row(ui, tone(ui, title, toneName), innerWidth),
        border(ui, ui.glyphs.dividerLeft, ui.glyphs.dividerRight, innerWidth + 4)
    ];

    if (lines.length === 0) {
        out.push(row(ui, "", innerWidth));
    } else {
        for (const line of lines) {
            if (!line) {
                out.push(row(ui, "", innerWidth));
                continue;
            }

            for (const wrapped of wrapLine(line, innerWidth)) {
                out.push(row(ui, wrapped, innerWidth));
            }
        }
    }

    out.push(border(ui, ui.glyphs.bottomLeft, ui.glyphs.bottomRight, innerWidth + 4));
    return out.join("\n");
}

function renderPlainList(title: string, items: string[]): string {
    return [
        `${title}:`,
        ...items.map((item) => `- ${item}`)
    ].join("\n");
}

function rankingSignals(candidate: CandidateDiagnostics): string[] {
    const signals: string[] = [];
    if (candidate.ranking.valid) signals.push("valid");
    if (candidate.ranking.expectedTypeMatch) signals.push("type-match");
    if (candidate.ranking.expectedScopeMatch) signals.push("scope-match");
    if (candidate.ranking.ticketFooterPresent) signals.push("ticket-footer");
    if (candidate.ranking.subjectWithinLimit) signals.push("subject-fit");
    if (candidate.ranking.genericDescriptionPenalty) signals.push("generic-penalty");
    return signals;
}

function originSignals(context: ContextDiagnostics, candidate: CandidateDiagnostics): string[] {
    const origins: string[] = [];
    if (context.expectedType.source !== "none" && context.expectedType.value) {
        origins.push(`type ${compactSource(context.expectedType.source)}`);
    }
    if (candidate.final.scope.value && candidate.final.scope.source !== "message" && candidate.final.scope.source !== "none") {
        origins.push(`scope ${compactSource(candidate.final.scope.source)}`);
    }
    if (candidate.final.ticket.value && candidate.final.ticket.source !== "message" && candidate.final.ticket.source !== "none") {
        origins.push(`ticket ${compactSource(candidate.final.ticket.source)}`);
    }
    return origins;
}

export function createTerminalUi(
    stream: TerminalStream | undefined,
    opts?: { forceRichLayout?: boolean; forceUnicode?: boolean }
): TerminalUi {
    const isTTY = Boolean(stream?.isTTY);
    const richLayout = opts?.forceRichLayout ?? isTTY;
    const unicode = opts?.forceUnicode ?? (richLayout ? detectUnicodeSupport(stream) : false);

    return {
        richLayout,
        color: isTTY,
        unicode,
        width: clampWidth(stream?.columns),
        glyphs: unicode ? UNICODE_GLYPHS : ASCII_GLYPHS
    };
}

export function renderMessageCard(
    ui: TerminalUi,
    context: ContextDiagnostics,
    candidate: CandidateDiagnostics,
    opts?: { title?: string; tone?: CardTone }
): string {
    const body = candidate.message
        .split("\n")
        .slice(1)
        .join("\n")
        .trim();
    const header = [
        tone(ui, `[${candidate.validation.ok ? "VALID" : "INVALID"}]`, candidate.validation.ok ? "success" : "warning"),
        tone(ui, `[${candidate.source === "repaired" ? "REPAIRED" : "MODEL"}]`, candidate.source === "repaired" ? "warning" : "accent")
    ].join(" ");
    const lines = [
        header,
        "",
        tone(ui, candidate.subject, "accent")
    ];

    if (body) {
        lines.push("");
        for (const bodyLine of body.split("\n")) {
            lines.push(bodyLine);
        }
    }

    const meta = formatMetaLine(ui, [
        `expected ${context.expectedType.value ?? "none"}`,
        `scope ${candidate.final.scope.value ?? "none"}`,
        `ticket ${candidate.final.ticket.value ?? "none"}`,
        `source ${candidate.source}`
    ]);
    lines.push("");
    lines.push(tone(ui, meta, "muted"));

    return renderCard(ui, opts?.title ?? "Review commit", lines, opts?.tone ?? "accent");
}

export function renderExplainBlock(
    ui: TerminalUi,
    context: ContextDiagnostics,
    candidate: CandidateDiagnostics,
    alternativesCount = 0
): string {
    const signals = rankingSignals(candidate);
    const signalLine = signals.length > 0
        ? `signals ${formatMetaLine(ui, signals)}`
        : "signals baseline fit";
    const scoreLine = formatMetaLine(ui, [
        `score ${candidate.ranking.total}`,
        alternativesCount > 0 ? `${alternativesCount} alternative${alternativesCount === 1 ? "" : "s"}` : null
    ]);
    const origins = originSignals(context, candidate);

    if (!ui.richLayout) {
        const lines = [
            `why: ${formatMetaLine(ui, rankingSignals(candidate)) || "baseline fit"}`,
            `score: ${candidate.ranking.total}`
        ];
        if (alternativesCount > 0) {
            lines.push(`alternatives: ${alternativesCount}`);
        }
        if (origins.length > 0) {
            lines.push(`from: ${formatMetaLine(ui, origins)}`);
        }
        return lines.join("\n");
    }

    const lines = [
        signalLine || "via baseline fit",
        scoreLine
    ];
    if (origins.length > 0) {
        lines.push(tone(ui, formatMetaLine(ui, origins), "muted"));
    }

    return renderCard(ui, "Why it won", lines, "accent");
}

export function renderValidationBlock(
    ui: TerminalUi,
    errors: string[],
    opts?: { title?: string; nextStep?: string; note?: string }
): string {
    if (!ui.richLayout) {
        const lines = [
            "errors:",
            ...errors.map((error) => `- ${error}`)
        ];
        if (opts?.note) lines.push(opts.note);
        if (opts?.nextStep) lines.push(`next: ${opts.nextStep}`);
        return lines.join("\n");
    }

    const lines = errors.map((error) => `${ui.glyphs.bullet} ${error}`);
    if (opts?.note) {
        lines.push("");
        lines.push(tone(ui, opts.note, "muted"));
    }
    if (opts?.nextStep) {
        lines.push("");
        lines.push(tone(ui, `next ${opts.nextStep}`, "muted"));
    }

    return renderCard(ui, opts?.title ?? "Needs attention", lines, "warning");
}

export function renderReviewScreen(
    ui: TerminalUi,
    context: ContextDiagnostics,
    candidate: CandidateDiagnostics,
    opts?: {
        explain?: boolean;
        alternativesCount?: number;
        validationNextStep?: string;
        title?: string;
    }
): string {
    if (!ui.richLayout) {
        const lines = [candidate.message];
        if (opts?.explain && candidate.validation.ok) {
            lines.push("");
            lines.push(renderExplainBlock(ui, context, candidate, opts.alternativesCount ?? 0));
        }

        if (!candidate.validation.ok) {
            lines.push("");
            lines.push(renderValidationBlock(ui, candidate.validation.errors, {
                nextStep: opts?.validationNextStep
            }));
        }

        return lines.join("\n");
    }

    const sections = [
        renderMessageCard(ui, context, candidate, {
            title: opts?.title ?? (candidate.validation.ok ? "Review commit" : "Generated message rejected"),
            tone: candidate.validation.ok ? "accent" : "warning"
        })
    ];

    if (!candidate.validation.ok) {
        sections.push(renderValidationBlock(ui, candidate.validation.errors, {
            nextStep: opts?.validationNextStep,
            note: opts?.explain ? `score ${candidate.ranking.total}` : undefined
        }));
        return sections.join("\n\n");
    }

    if (opts?.explain) {
        sections.push(renderExplainBlock(ui, context, candidate, opts.alternativesCount ?? 0));
    }

    return sections.join("\n\n");
}

export function renderActionSummary(ui: TerminalUi, title: string, lines: string[]): string {
    if (!ui.richLayout) {
        return renderPlainList(title, lines);
    }

    return renderCard(
        ui,
        title,
        lines.map((line) => `${ui.glyphs.bullet} ${line}`),
        "success"
    );
}

export function renderStateCard(
    ui: TerminalUi,
    opts: {
        title: string;
        headline: string;
        meta?: Array<string | null | undefined>;
        tone?: CardTone;
    }
): string {
    const meta = formatMetaLine(ui, opts.meta ?? []);
    if (!ui.richLayout) {
        const lines = [opts.headline];
        if (meta) lines.push(meta);
        return [opts.title, ...lines].join("\n");
    }

    const lines = [tone(ui, opts.headline, "accent")];
    if (meta) {
        lines.push("");
        lines.push(tone(ui, meta, "muted"));
    }

    return renderCard(ui, opts.title, lines, opts.tone ?? "success");
}

export function renderErrorBlock(
    ui: TerminalUi,
    problem: string,
    why: string,
    nextStep?: string
): string {
    if (!ui.richLayout) {
        return [
            `Problem: ${problem}`,
            `Why: ${why}`,
            `Next: ${nextStep ?? "Review the error details and retry."}`
        ].join("\n");
    }

    return renderCard(ui, problem, [
        why,
        "",
        tone(ui, `next ${nextStep ?? "Review the error details and retry."}`, "muted")
    ], "danger");
}

function renderDoctorSection(ui: TerminalUi, section: string, checks: DoctorCheck[]): string {
    if (!ui.richLayout) {
        const lines = [`${section}:`];
        for (const check of checks) {
            lines.push(`- ${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
            if (check.nextStep) lines.push(`  next: ${check.nextStep}`);
        }
        return lines.join("\n");
    }

    const lines: string[] = [];
    for (const check of checks) {
        const status = check.ok ? ui.glyphs.ok : ui.glyphs.fail;
        lines.push(`${status} ${check.name}: ${check.detail}`);
        if (check.nextStep) {
            lines.push(tone(ui, `next ${check.nextStep}`, "muted"));
        }
    }

    return renderCard(ui, section, lines, checks.every((check) => check.ok) ? "accent" : "warning");
}

export function renderDoctorReport(ui: TerminalUi, result: DoctorResult): string {
    const sections = new Map<string, DoctorCheck[]>();
    for (const check of result.checks) {
        const bucket = sections.get(check.section) ?? [];
        bucket.push(check);
        sections.set(check.section, bucket);
    }

    const failingChecks = result.checks.filter((check) => !check.ok).length;
    const out = [
        renderStateCard(ui, {
            title: "Doctor",
            headline: result.ok ? "All checks passed" : `${failingChecks} check${failingChecks === 1 ? "" : "s"} need attention`,
            meta: result.ok ? ["environment ready", "repository ready", "ollama ready"] : ["review the failing section below"],
            tone: result.ok ? "success" : "warning"
        })
    ];

    for (const [section, checks] of sections.entries()) {
        out.push(renderDoctorSection(ui, section, checks));
    }

    return out.join("\n\n");
}
