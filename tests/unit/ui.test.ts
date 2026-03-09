import { describe, expect, it } from "vitest";
import type { CandidateDiagnostics, ContextDiagnostics } from "../../src/diagnostics.js";
import type { DoctorResult } from "../../src/doctor.js";
import {
    createTerminalUi,
    renderActionSummary,
    renderDoctorReport,
    renderErrorBlock,
    renderExplainBlock,
    renderReviewScreen,
    renderStateCard,
    renderValidationBlock
} from "../../src/ui.js";

function baseContext(): ContextDiagnostics {
    return {
        expectedType: {
            value: "feat",
            source: "diff"
        },
        scope: {
            suggested: "cli",
            effective: "cli",
            source: "changed-files"
        },
        ticket: {
            value: "ABC-123",
            source: "branch"
        }
    };
}

function baseCandidate(overrides: Partial<CandidateDiagnostics> = {}): CandidateDiagnostics {
    return {
        message: "feat(cli): add baseline\n\nRefs ABC-123",
        subject: "feat(cli): add baseline",
        source: "repaired",
        final: {
            type: "feat",
            scope: {
                value: "cli",
                source: "changed-files"
            },
            ticket: {
                value: "ABC-123",
                source: "branch"
            }
        },
        validation: {
            ok: true,
            errors: []
        },
        ranking: {
            valid: true,
            validPoints: 1_000_000,
            subjectWithinLimit: true,
            subjectWithinLimitPoints: 100_000,
            expectedTypeMatch: true,
            expectedTypePoints: 10_000,
            expectedScopeMatch: true,
            expectedScopePoints: 1_000,
            ticketFooterPresent: true,
            ticketFooterPoints: 100,
            genericDescriptionPenalty: false,
            genericDescriptionPoints: 0,
            total: 1_111_100
        },
        ...overrides
    };
}

describe("ui renderers", () => {
    it("renders the primary review screen as a stable rich-layout snapshot", () => {
        const ui = createTerminalUi({ isTTY: false, columns: 80 }, {
            forceRichLayout: true,
            forceUnicode: true
        });

        expect(renderReviewScreen(ui, baseContext(), baseCandidate(), {
            explain: true,
            alternativesCount: 1
        })).toBe([
            "╭──────────────────────────────────────────────────────────────────────────────╮",
            "│ Review commit                                                                │",
            "├──────────────────────────────────────────────────────────────────────────────┤",
            "│ [VALID] [REPAIRED]                                                           │",
            "│                                                                              │",
            "│ feat(cli): add baseline                                                      │",
            "│                                                                              │",
            "│ Refs ABC-123                                                                 │",
            "│                                                                              │",
            "│ expected feat · scope cli · ticket ABC-123 · source repaired                 │",
            "╰──────────────────────────────────────────────────────────────────────────────╯",
            "",
            "╭──────────────────────────────────────────────────────────────────────────────╮",
            "│ Why it won                                                                   │",
            "├──────────────────────────────────────────────────────────────────────────────┤",
            "│ signals valid · type-match · scope-match · ticket-footer · subject-fit       │",
            "│ score 1111100 · 1 alternative                                                │",
            "│ type diff · scope files · ticket branch                                      │",
            "╰──────────────────────────────────────────────────────────────────────────────╯"
        ].join("\n"));
    });

    it("renders a representative failure block as a stable snapshot", () => {
        const ui = createTerminalUi({ isTTY: false, columns: 80 }, {
            forceRichLayout: true,
            forceUnicode: true
        });

        expect(renderErrorBlock(
            ui,
            "Generated message failed validation",
            "Scope is required and must be one of: cli.",
            "Revise, edit, regenerate, or rerun with `--allow-invalid` if you want to override."
        )).toBe([
            "╭──────────────────────────────────────────────────────────────────────────────╮",
            "│ Generated message failed validation                                          │",
            "├──────────────────────────────────────────────────────────────────────────────┤",
            "│ Scope is required and must be one of: cli.                                   │",
            "│                                                                              │",
            "│ next Revise, edit, regenerate, or rerun with `--allow-invalid` if you want   │",
            "│ to override.                                                                 │",
            "╰──────────────────────────────────────────────────────────────────────────────╯"
        ].join("\n"));
    });

    it("supports an ASCII rich-layout fallback for card rendering", () => {
        const ui = createTerminalUi({ isTTY: false, columns: 72 }, {
            forceRichLayout: true,
            forceUnicode: false
        });

        expect(renderActionSummary(ui, "Hooks installed", [
            "/repo/.git/hooks/prepare-commit-msg"
        ])).toBe([
            "+----------------------------------------------------------------------+",
            "| Hooks installed                                                      |",
            "+----------------------------------------------------------------------+",
            "| - /repo/.git/hooks/prepare-commit-msg                                |",
            "+----------------------------------------------------------------------+"
        ].join("\n"));
    });

    it("falls back to plain output when the caller does not request a rich layout", () => {
        const ui = createTerminalUi({ isTTY: false, columns: 80 });

        expect(renderReviewScreen(ui, baseContext(), baseCandidate(), {
            explain: false
        })).toBe("feat(cli): add baseline\n\nRefs ABC-123");
    });

    it("renders compact plain explain and validation output without extra sections", () => {
        const ui = createTerminalUi({ isTTY: false, columns: 80 });
        const invalidCandidate = baseCandidate({
            message: "bad message",
            subject: "bad message",
            source: "model",
            final: {
                type: null,
                scope: {
                    value: null,
                    source: "none"
                },
                ticket: {
                    value: null,
                    source: "none"
                }
            },
            validation: {
                ok: false,
                errors: [
                    "Not Conventional Commits format",
                    "Message must reference a ticket."
                ]
            },
            ranking: {
                valid: false,
                validPoints: 0,
                subjectWithinLimit: false,
                subjectWithinLimitPoints: 0,
                expectedTypeMatch: false,
                expectedTypePoints: 0,
                expectedScopeMatch: false,
                expectedScopePoints: 0,
                ticketFooterPresent: false,
                ticketFooterPoints: 0,
                genericDescriptionPenalty: true,
                genericDescriptionPoints: -10,
                total: -10
            }
        });

        expect(renderReviewScreen(ui, baseContext(), invalidCandidate, {
            explain: true,
            validationNextStep: "Regenerate the message and retry."
        })).toBe([
            "bad message",
            "",
            "errors:",
            "- Not Conventional Commits format",
            "- Message must reference a ticket.",
            "next: Regenerate the message and retry."
        ].join("\n"));

        expect(renderValidationBlock(ui, ["Missing ticket footer"], {
            note: "score -10",
            nextStep: "Add a ticket footer."
        })).toBe([
            "errors:",
            "- Missing ticket footer",
            "score -10",
            "next: Add a ticket footer."
        ].join("\n"));
    });

    it("renders baseline rich explain output when no ranking signals or origins apply", () => {
        const ui = createTerminalUi({ isTTY: false, columns: 72 }, {
            forceRichLayout: true,
            forceUnicode: false
        });
        const minimalCandidate = baseCandidate({
            message: "chore: bump deps",
            subject: "chore: bump deps",
            source: "model",
            final: {
                type: "chore",
                scope: {
                    value: null,
                    source: "message"
                },
                ticket: {
                    value: null,
                    source: "none"
                }
            },
            ranking: {
                valid: false,
                validPoints: 0,
                subjectWithinLimit: false,
                subjectWithinLimitPoints: 0,
                expectedTypeMatch: false,
                expectedTypePoints: 0,
                expectedScopeMatch: false,
                expectedScopePoints: 0,
                ticketFooterPresent: false,
                ticketFooterPoints: 0,
                genericDescriptionPenalty: false,
                genericDescriptionPoints: 0,
                total: 0
            }
        });

        expect(renderExplainBlock(ui, {
            expectedType: {
                value: null,
                source: "none"
            },
            scope: {
                suggested: null,
                effective: null,
                source: "none"
            },
            ticket: {
                value: null,
                source: "none"
            }
        }, minimalCandidate)).toBe([
            "+----------------------------------------------------------------------+",
            "| Why it won                                                           |",
            "+----------------------------------------------------------------------+",
            "| signals baseline fit                                                 |",
            "| score 0                                                              |",
            "+----------------------------------------------------------------------+"
        ].join("\n"));
    });

    it("supports plain error output and tty-colored rich state cards", () => {
        const plainUi = createTerminalUi({ isTTY: false, columns: 80 });
        expect(renderErrorBlock(plainUi, "Hook install failed", "Existing hook is unmanaged")).toBe([
            "Problem: Hook install failed",
            "Why: Existing hook is unmanaged",
            "Next: Review the error details and retry."
        ].join("\n"));

        const ttyUi = createTerminalUi({ isTTY: true, columns: 68 }, {
            forceRichLayout: true,
            forceUnicode: false
        });
        const rendered = renderStateCard(ttyUi, {
            title: "Commit created",
            headline: "fix(cli): tighten output",
            meta: ["scope cli"],
            tone: "success"
        });

        expect(rendered).toContain("\u001b[1m\u001b[32mCommit created\u001b[0m");
        expect(rendered).toContain("\u001b[1m\u001b[36mfix(cli): tighten output\u001b[0m");
    });

    it("includes doctor sections and next steps in the report", () => {
        const ui = createTerminalUi({ isTTY: false, columns: 80 }, {
            forceRichLayout: true,
            forceUnicode: false
        });
        const result: DoctorResult = {
            ok: false,
            exitCode: 3,
            checks: [
                {
                    section: "Environment",
                    name: "Node.js",
                    ok: true,
                    detail: "Detected 20.12.0"
                },
                {
                    section: "Ollama",
                    name: "Configured model",
                    ok: false,
                    detail: "Model not found",
                    nextStep: "Run `ollama pull gpt-oss:120b-cloud` and retry."
                }
            ]
        };

        const report = renderDoctorReport(ui, result);
        expect(report).toContain("| Doctor");
        expect(report).toContain("| Environment");
        expect(report).toContain("| Ollama");
        expect(report).toContain("next Run `ollama pull gpt-oss:120b-cloud` and retry.");
    });

    it("renders plain doctor sections and default width fallback cleanly", () => {
        const ui = createTerminalUi(undefined);
        const result: DoctorResult = {
            ok: false,
            exitCode: 3,
            checks: [
                {
                    section: "Environment",
                    name: "Node.js",
                    ok: true,
                    detail: "Detected 20.12.0"
                },
                {
                    section: "Ollama",
                    name: "Configured model",
                    ok: false,
                    detail: "Model not found",
                    nextStep: "Run `ollama pull gpt-oss:120b-cloud` and retry."
                }
            ]
        };

        expect(ui.width).toBe(88);
        expect(ui.richLayout).toBe(false);
        expect(ui.unicode).toBe(false);
        expect(renderDoctorReport(ui, result)).toBe([
            "Doctor",
            "1 check need attention",
            "review the failing section below",
            "",
            "Environment:",
            "- OK Node.js: Detected 20.12.0",
            "",
            "Ollama:",
            "- FAIL Configured model: Model not found",
            "  next: Run `ollama pull gpt-oss:120b-cloud` and retry."
        ].join("\n"));
    });
});
