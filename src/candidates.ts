import { ollamaChat } from "./ollama.js";
import { extractTicketFromMessage, lintCommitMessage } from "./policy.js";
import { buildMessages } from "./prompt.js";
import { rankCandidates, type RankedCandidate } from "./ranking.js";
import {
    appendTicketFooter,
    extractMessageFromModelOutput,
    extractMessageListFromModelOutput,
    normalizeMessage,
    parseConventionalSubject,
    repairMessage
} from "./validation.js";
import type { RepoContext, ResolvedWorkflowOptions } from "./workflow.js";

type CandidateDraft = Pick<RankedCandidate, "message" | "source" | "validation" | "validationErrors">;

function normalizeFeedback(feedback: string): string {
    return feedback.trim().toLowerCase();
}

function requestsTicketRemoval(feedback: string): boolean {
    const normalized = normalizeFeedback(feedback);
    return /\b(remove|drop|omit|delete|without)\b/.test(normalized) && /\bticket\b|\bfooter\b/.test(normalized);
}

function requestsScopeRemoval(feedback: string): boolean {
    const normalized = normalizeFeedback(feedback);
    return /\b(remove|drop|omit|delete|without)\b/.test(normalized) && /\bscope\b/.test(normalized);
}

function toCandidateDraft(
    rawMessage: string,
    context: RepoContext,
    options: ResolvedWorkflowOptions
): CandidateDraft {
    const repaired = repairMessage({
        message: rawMessage,
        diff: context.diff,
        forcedType: options.type,
        scope: context.effectiveScope,
        ticket: context.ticket
    });

    const message = normalizeMessage(repaired.message);
    const lintResult = lintCommitMessage(message, options.policy, options.ticketPattern);
    return {
        message,
        source: repaired.didRepair ? "repaired" : "model",
        validationErrors: lintResult.errors,
        validation: lintResult.ok
            ? { ok: true }
            : { ok: false, reason: lintResult.errors[0] ?? "Invalid commit message" }
    };
}

function resolveRevisionScope(
    revisedMessage: string,
    currentMessage: string,
    context: RepoContext,
    options: ResolvedWorkflowOptions,
    feedback: string
): string | null {
    if (options.scope) return options.scope;
    const revisedScope = parseConventionalSubject(revisedMessage.split("\n")[0]?.trim() ?? "")?.scope;
    const currentScope = parseConventionalSubject(currentMessage.split("\n")[0]?.trim() ?? "")?.scope;
    const requiredScopes = new Set(options.policy.requiredScopes);

    if (options.policy.requiredScopes.length === 0) {
        if (revisedScope) return null;
        if (requestsScopeRemoval(feedback)) return null;
        return currentScope ?? null;
    }

    if (revisedScope && requiredScopes.has(revisedScope)) return revisedScope;
    if (currentScope && requiredScopes.has(currentScope)) return currentScope;
    if (context.effectiveScope && requiredScopes.has(context.effectiveScope)) return context.effectiveScope;
    return options.policy.requiredScopes[0] ?? null;
}

function toRevisedCandidateDraft(
    rawMessage: string,
    currentMessage: string,
    context: RepoContext,
    options: ResolvedWorkflowOptions,
    feedback: string
): CandidateDraft {
    const repaired = repairMessage({
        message: rawMessage,
        diff: context.diff,
        forcedType: options.type,
        scope: resolveRevisionScope(rawMessage, currentMessage, context, options, feedback),
        ticket: options.ticket
    });

    let message = normalizeMessage(repaired.message);
    const detectedTicket = extractTicketFromMessage(message, options.ticketPattern);
    const currentTicket = extractTicketFromMessage(currentMessage, options.ticketPattern);
    if (!detectedTicket) {
        if (options.policy.requireTicket && context.ticket) {
            message = appendTicketFooter(message, context.ticket);
        } else if (currentTicket && !requestsTicketRemoval(feedback)) {
            message = appendTicketFooter(message, currentTicket);
        }
    }

    const lintResult = lintCommitMessage(message, options.policy, options.ticketPattern);
    return {
        message,
        source: repaired.didRepair || message !== normalizeMessage(rawMessage) ? "repaired" : "model",
        validationErrors: lintResult.errors,
        validation: lintResult.ok
            ? { ok: true }
            : { ok: false, reason: lintResult.errors[0] ?? "Invalid commit message" }
    };
}

async function requestModelOutput(
    context: RepoContext,
    options: ResolvedWorkflowOptions,
    candidateCount: number,
    revisionRequest?: {
        currentMessage: string;
        feedback: string;
    }
): Promise<string> {
    const messages = buildMessages({
        diff: context.diff,
        files: context.files,
        branch: context.branch,
        suggestedScope: context.effectiveScope,
        ticket: context.ticket,
        recentExamples: context.recentExamples,
        forcedType: options.type,
        forcedScope: options.scope,
        knownScopes: options.knownScopes,
        candidateCount,
        policy: options.policy,
        revisionRequest
    });

    return (await ollamaChat({
        host: options.host,
        model: options.model,
        messages,
        json: true,
        timeoutMs: options.timeoutMs,
        retries: options.retries
    })).trim();
}

async function generateSingleCandidate(
    context: RepoContext,
    options: ResolvedWorkflowOptions
): Promise<CandidateDraft> {
    const raw = await requestModelOutput(context, options, 1);
    return toCandidateDraft(extractMessageFromModelOutput(raw), context, options);
}

async function generateBatchCandidates(
    context: RepoContext,
    options: ResolvedWorkflowOptions
): Promise<CandidateDraft[]> {
    const raw = await requestModelOutput(context, options, options.candidates);
    const messages = extractMessageListFromModelOutput(raw);
    if (!messages || messages.length === 0) return [];

    return messages.map((message) => toCandidateDraft(message, context, options));
}

function pushUniqueCandidate(
    candidate: CandidateDraft,
    uniqueMessages: Set<string>,
    candidates: CandidateDraft[]
): void {
    if (uniqueMessages.has(candidate.message)) return;
    uniqueMessages.add(candidate.message);
    candidates.push(candidate);
}

export async function generateCandidates(
    context: RepoContext,
    options: ResolvedWorkflowOptions
): Promise<RankedCandidate[]> {
    const attempts = Math.max(options.candidates, 1) * 3;
    const uniqueMessages = new Set<string>();
    const candidates: CandidateDraft[] = [];

    if (options.candidates > 1) {
        const batchCandidates = await generateBatchCandidates(context, options);
        for (const candidate of batchCandidates) {
            pushUniqueCandidate(candidate, uniqueMessages, candidates);
            if (candidates.length >= options.candidates) break;
        }
    }

    for (let attempt = 0; attempt < attempts && candidates.length < options.candidates; attempt += 1) {
        const candidate = await generateSingleCandidate(context, options);
        pushUniqueCandidate(candidate, uniqueMessages, candidates);
    }

    return rankCandidates(candidates, {
        expectedType: context.expectedType,
        expectedScope: context.effectiveScope,
        ticket: context.ticket,
        subjectMaxLength: options.policy.subjectMaxLength
    });
}

export async function reviseCandidate(
    context: RepoContext,
    options: ResolvedWorkflowOptions,
    currentMessage: string,
    feedback: string
): Promise<RankedCandidate> {
    const raw = await requestModelOutput(context, options, 1, {
        currentMessage,
        feedback
    });
    const candidate = toRevisedCandidateDraft(
        extractMessageFromModelOutput(raw),
        currentMessage,
        context,
        options,
        feedback
    );
    return {
        ...candidate,
        ...rankCandidates([candidate], {
            expectedType: context.expectedType,
            expectedScope: context.effectiveScope,
            ticket: context.ticket,
            subjectMaxLength: options.policy.subjectMaxLength
        })[0]
    };
}
