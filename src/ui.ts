import type { CandidateDiagnostics, ContextDiagnostics, DiagnosticSource } from "./diagnostics.js";
import type { DoctorResult } from "./doctor.js";

type TerminalStream = {
    isTTY?: boolean;
    columns?: number;
};

type Tone = "accent" | "danger" | "muted" | "success" | "warning";

export type TerminalUi = {
    richLayout: boolean;
    color: boolean;
    width: number;
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

function clampWidth(columns: number | undefined): number {
    const fallback = 88;
    if (!columns || !Number.isFinite(columns)) return fallback;
    return Math.max(64, Math.min(100, Math.floor(columns)));
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

function heading(ui: TerminalUi, title: string): string {
    return tone(ui, `== ${title} ==`, "accent");
}

function badge(ui: TerminalUi, label: string, color: Tone): string {
    return tone(ui, `[${label}]`, color);
}

function wrapLine(line: string, width: number): string[] {
    const normalized = line.trim();
    if (!normalized) return [""];
    if (normalized.length <= width) return [normalized];

    const words = normalized.split(/\s+/);
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        if (!current) {
            current = word;
            continue;
        }

        if (`${current} ${word}`.length <= width) {
            current = `${current} ${word}`;
            continue;
        }

        lines.push(current);
        current = word;
    }

    if (current) lines.push(current);
    return lines;
}

function pushWrapped(
    lines: string[],
    width: number,
    firstPrefix: string,
    nextPrefix: string,
    value: string
): void {
    const sourceLines = value.split("\n");

    for (let index = 0; index < sourceLines.length; index += 1) {
        const rawLine = sourceLines[index] ?? "";
        const first = index === 0 ? firstPrefix : nextPrefix;
        const follow = " ".repeat(first.length);
        const wrapped = wrapLine(rawLine, Math.max(16, width - first.length));

        wrapped.forEach((entry, wrapIndex) => {
            lines.push(`${wrapIndex === 0 ? first : follow}${entry}`.trimEnd());
        });
    }
}

function formatValueWithSource(value: string | null, source: DiagnosticSource): string {
    if (!value) return "none";
    return `${value} (${describeSource(source)})`;
}

function describeSource(source: DiagnosticSource): string {
    switch (source) {
        case "cli":
            return "CLI override";
        case "diff":
            return "diff inference";
        case "changed-files":
            return "changed files";
        case "default-config":
            return "repo default";
        case "branch":
            return "branch inference";
        case "message":
            return "message content";
        default:
            return "not set";
    }
}

function formatRankingSummary(candidate: CandidateDiagnostics): string {
    const details: string[] = [];
    if (candidate.ranking.valid) details.push("valid");
    if (candidate.ranking.subjectWithinLimit) details.push("subject-fit");
    if (candidate.ranking.expectedTypeMatch) details.push("type-match");
    if (candidate.ranking.expectedScopeMatch) details.push("scope-match");
    if (candidate.ranking.ticketFooterPresent) details.push("ticket-footer");
    if (candidate.ranking.genericDescriptionPenalty) details.push("generic-penalty");

    return `${candidate.ranking.total} (${details.join(", ") || "no bonuses"})`;
}

function renderKeyValueBlock(
    ui: TerminalUi,
    title: string,
    items: Array<{ label: string; value: string }>
): string {
    const labelWidth = items.reduce((max, item) => Math.max(max, item.label.length), 0);
    const lines = [heading(ui, title)];

    for (const item of items) {
        const prefix = `  ${item.label.padEnd(labelWidth)} : `;
        pushWrapped(lines, ui.width, prefix, prefix, item.value);
    }

    return lines.join("\n");
}

export function createTerminalUi(
    stream: TerminalStream | undefined,
    opts?: { forceRichLayout?: boolean }
): TerminalUi {
    const isTTY = Boolean(stream?.isTTY);
    return {
        richLayout: opts?.forceRichLayout ?? isTTY,
        color: isTTY,
        width: clampWidth(stream?.columns)
    };
}

export function renderMessageCard(ui: TerminalUi, candidate: CandidateDiagnostics): string {
    const [, ...bodyLines] = candidate.message.split("\n");
    const body = bodyLines.join("\n").trim();
    const statuses = [
        badge(ui, candidate.validation.ok ? "VALID" : "INVALID", candidate.validation.ok ? "success" : "danger"),
        badge(ui, candidate.source === "repaired" ? "REPAIRED" : "MODEL", candidate.source === "repaired" ? "warning" : "accent"),
        candidate.final.scope.value ? badge(ui, `SCOPE ${candidate.final.scope.value}`, "accent") : null,
        candidate.final.ticket.value ? badge(ui, `TICKET ${candidate.final.ticket.value}`, "accent") : null
    ]
        .filter((value): value is string => Boolean(value))
        .join(" ");

    const lines = [
        heading(ui, "Commit preview"),
        `  ${statuses}`
    ];

    pushWrapped(lines, ui.width, "  Subject : ", "  Subject : ", candidate.subject);
    if (body) {
        lines.push("  Body    :");
        for (const bodyLine of body.split("\n")) {
            pushWrapped(lines, ui.width, "    ", "    ", bodyLine);
        }
    }

    return lines.join("\n");
}

export function renderExplainBlock(
    ui: TerminalUi,
    context: ContextDiagnostics,
    candidate: CandidateDiagnostics,
    alternativesCount = 0
): string {
    const items = [
        { label: "Source", value: candidate.source },
        { label: "Expected type", value: formatValueWithSource(context.expectedType.value, context.expectedType.source) },
        { label: "Selected scope", value: formatValueWithSource(candidate.final.scope.value, candidate.final.scope.source) },
        { label: "Selected ticket", value: formatValueWithSource(candidate.final.ticket.value, candidate.final.ticket.source) },
        { label: "Validation", value: candidate.validation.ok ? "valid" : "invalid" },
        { label: "Ranking", value: formatRankingSummary(candidate) }
    ];

    if (alternativesCount > 0) {
        items.push({ label: "Alternatives", value: String(alternativesCount) });
    }

    const lines = [renderKeyValueBlock(ui, "Why this message", items)];
    if (!candidate.validation.ok && candidate.validation.errors.length > 0) {
        lines.push("");
        lines.push(renderValidationBlock(ui, candidate.validation.errors));
    }

    return lines.join("\n");
}

export function renderValidationBlock(
    ui: TerminalUi,
    errors: string[],
    nextStep?: string
): string {
    const lines = [heading(ui, "Validation issues")];
    for (const error of errors) {
        pushWrapped(lines, ui.width, "  - ", "    ", error);
    }

    if (nextStep) {
        lines.push("");
        lines.push(renderActionSummary(ui, "Next step", [nextStep]));
    }

    return lines.join("\n");
}

export function renderReviewScreen(
    ui: TerminalUi,
    context: ContextDiagnostics,
    candidate: CandidateDiagnostics,
    opts?: {
        explain?: boolean;
        alternativesCount?: number;
        validationNextStep?: string;
    }
): string {
    if (!ui.richLayout) {
        const lines = [candidate.message];
        if (opts?.explain) {
            lines.push("");
            lines.push(renderExplainBlock(ui, context, candidate, opts.alternativesCount ?? 0));
        }
        return lines.join("\n");
    }

    const sections = [
        heading(ui, "Review commit message"),
        renderKeyValueBlock(ui, "Context", [
            { label: "Expected type", value: formatValueWithSource(context.expectedType.value, context.expectedType.source) },
            { label: "Scope", value: formatValueWithSource(context.scope.effective, context.scope.source) },
            { label: "Ticket", value: formatValueWithSource(context.ticket.value, context.ticket.source) }
        ]),
        renderMessageCard(ui, candidate)
    ];

    if (!candidate.validation.ok) {
        sections.push(renderValidationBlock(
            ui,
            candidate.validation.errors,
            opts?.validationNextStep
        ));
    }

    if (opts?.explain) {
        sections.push(renderExplainBlock(ui, context, candidate, opts.alternativesCount ?? 0));
    }

    return sections.join("\n\n");
}

export function renderActionSummary(ui: TerminalUi, title: string, lines: string[]): string {
    const rendered = [heading(ui, title)];
    for (const line of lines) {
        pushWrapped(rendered, ui.width, "  - ", "    ", line);
    }
    return rendered.join("\n");
}

export function renderErrorBlock(
    ui: TerminalUi,
    problem: string,
    why: string,
    nextStep?: string
): string {
    return renderKeyValueBlock(ui, "Problem", [
        { label: "Problem", value: problem },
        { label: "Why", value: why },
        { label: "Next step", value: nextStep ?? "Review the error details and retry." }
    ]);
}

export function renderDoctorReport(ui: TerminalUi, result: DoctorResult): string {
    const sections = new Map<string, typeof result.checks>();
    for (const check of result.checks) {
        const bucket = sections.get(check.section) ?? [];
        bucket.push(check);
        sections.set(check.section, bucket);
    }

    const lines = [
        heading(ui, "Doctor"),
        tone(ui, result.ok ? "All checks passed." : "Some checks need attention.", result.ok ? "success" : "warning")
    ];

    for (const [section, checks] of sections.entries()) {
        lines.push("");
        lines.push(heading(ui, section));
        for (const check of checks) {
            const status = badge(ui, check.ok ? "OK" : "FAIL", check.ok ? "success" : "danger");
            pushWrapped(lines, ui.width, `  ${status} ${check.name}: `, `  ${" ".repeat(check.name.length + 7)}`, check.detail);
            if (check.nextStep) {
                pushWrapped(lines, ui.width, "    next: ", "          ", check.nextStep);
            }
        }
    }

    return lines.join("\n");
}
