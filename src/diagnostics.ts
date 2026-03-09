import { extractTicketFromMessage, lintCommitMessage } from "./policy.js";
import type { RankedCandidate, ScoreBreakdown, ScoreContext } from "./ranking.js";
import { getScoreBreakdown, parseRankedMessage } from "./ranking.js";
import { normalizeScopeName } from "./util.js";
import type { RepoContext, ResolvedWorkflowOptions } from "./workflow.js";

export type DiagnosticSource =
    | "cli"
    | "diff"
    | "changed-files"
    | "default-config"
    | "branch"
    | "message"
    | "none";

export type WorkflowDiagnostics = {
    context: ContextDiagnostics;
    selected?: CandidateDiagnostics;
    candidates?: CandidateDiagnostics[];
};

export type ContextDiagnostics = {
    expectedType: {
        value: string | null;
        source: DiagnosticSource;
    };
    scope: {
        suggested: string | null;
        effective: string | null;
        source: DiagnosticSource;
    };
    ticket: {
        value: string | null;
        source: DiagnosticSource;
    };
};

export type CandidateDiagnostics = {
    message: string;
    subject: string;
    source: RankedCandidate["source"];
    final: {
        type: string | null;
        scope: {
            value: string | null;
            source: DiagnosticSource;
        };
        ticket: {
            value: string | null;
            source: DiagnosticSource;
        };
    };
    validation: {
        ok: boolean;
        errors: string[];
    };
    ranking: ScoreBreakdown;
};

function getContextExpectedTypeSource(
    context: RepoContext,
    options: ResolvedWorkflowOptions
): DiagnosticSource {
    if (options.type) return "cli";
    if (context.expectedType) return "diff";
    return "none";
}

function getContextScopeSource(
    context: RepoContext,
    options: ResolvedWorkflowOptions
): DiagnosticSource {
    if (options.scope) return "cli";
    if (context.suggestedScope) return "changed-files";
    if (options.defaultScope) return "default-config";
    return "none";
}

function getContextTicketSource(
    context: RepoContext,
    options: ResolvedWorkflowOptions
): DiagnosticSource {
    if (options.ticket) return "cli";
    if (context.ticket) return "branch";
    return "none";
}

function getFinalScopeSource(
    scope: string | null,
    context: RepoContext,
    options: ResolvedWorkflowOptions
): DiagnosticSource {
    if (!scope) return "none";
    if (options.scope && scope === options.scope) return "cli";
    if (context.suggestedScope && scope === context.suggestedScope) return "changed-files";
    if (!options.scope && options.defaultScope && scope === options.defaultScope) return "default-config";
    return "message";
}

function getFinalTicketSource(
    ticket: string | null,
    context: RepoContext,
    options: ResolvedWorkflowOptions
): DiagnosticSource {
    if (!ticket) return "none";
    if (options.ticket && ticket === options.ticket) return "cli";
    if (!options.ticket && context.ticket && ticket === context.ticket) return "branch";
    return "message";
}

function getCandidateValidationErrors(
    candidate: RankedCandidate,
    options: ResolvedWorkflowOptions
): string[] {
    if (candidate.validation.ok) return [];
    if (candidate.validationErrors && candidate.validationErrors.length > 0) {
        return candidate.validationErrors;
    }

    return lintCommitMessage(candidate.message, options.policy, options.ticketPattern).errors;
}

function buildScoreContext(
    context: RepoContext,
    options: ResolvedWorkflowOptions
): ScoreContext {
    return {
        expectedType: context.expectedType,
        expectedScope: context.effectiveScope,
        ticket: context.ticket,
        subjectMaxLength: options.policy.subjectMaxLength
    };
}

export function buildCandidateDiagnostics(
    candidate: RankedCandidate,
    context: RepoContext,
    options: ResolvedWorkflowOptions
): CandidateDiagnostics {
    const parsed = parseRankedMessage(candidate.message);
    const finalScope = normalizeScopeName(parsed.scope);
    const finalTicket = extractTicketFromMessage(candidate.message, options.ticketPattern);
    const ranking = candidate.scoreBreakdown ?? getScoreBreakdown(
        candidate.message,
        candidate.validation,
        buildScoreContext(context, options)
    );

    return {
        message: candidate.message,
        subject: parsed.subject,
        source: candidate.source,
        final: {
            type: parsed.type,
            scope: {
                value: finalScope,
                source: getFinalScopeSource(finalScope, context, options)
            },
            ticket: {
                value: finalTicket,
                source: getFinalTicketSource(finalTicket, context, options)
            }
        },
        validation: {
            ok: candidate.validation.ok,
            errors: getCandidateValidationErrors(candidate, options)
        },
        ranking
    };
}

export function buildWorkflowDiagnostics(
    context: RepoContext,
    options: ResolvedWorkflowOptions,
    selected?: RankedCandidate,
    candidates?: RankedCandidate[]
): WorkflowDiagnostics {
    return {
        context: buildContextDiagnostics(context, options),
        selected: selected ? buildCandidateDiagnostics(selected, context, options) : undefined,
        candidates: candidates && candidates.length > 1
            ? candidates.map((candidate) => buildCandidateDiagnostics(candidate, context, options))
            : undefined
    };
}

export function buildContextDiagnostics(
    context: RepoContext,
    options: ResolvedWorkflowOptions
): ContextDiagnostics {
    return {
        expectedType: {
            value: context.expectedType,
            source: getContextExpectedTypeSource(context, options)
        },
        scope: {
            suggested: context.suggestedScope,
            effective: context.effectiveScope,
            source: getContextScopeSource(context, options)
        },
        ticket: {
            value: context.ticket,
            source: getContextTicketSource(context, options)
        }
    };
}
