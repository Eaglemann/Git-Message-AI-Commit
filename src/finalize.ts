import { ExitCode } from "./exit-codes.js";
import { gitCommit } from "./git.js";
import { appendHistory } from "./history.js";
import { normalizeErrorMessage } from "./util.js";
import { parseConventionalSubject } from "./validation.js";
import { WorkflowError } from "./workflow-errors.js";
import type { MessageSource, RepoContext, ResolvedWorkflowOptions, SuccessResult } from "./workflow.js";
import type { RankedCandidate } from "./ranking.js";

export function getMessageSubject(message: string): string {
    return message.split("\n")[0]?.trim() ?? "";
}

function getMessageScope(message: string): string | null {
    const parsed = parseConventionalSubject(getMessageSubject(message));
    return parsed?.scope ?? null;
}

export function buildSuccessResult(
    message: string,
    source: MessageSource,
    committed: boolean,
    cancelled: boolean,
    context: RepoContext,
    alternatives: string[]
): SuccessResult {
    return {
        ok: true,
        exitCode: ExitCode.Success,
        message,
        source,
        committed,
        cancelled,
        scope: getMessageScope(message),
        ticket: context.ticket,
        alternatives: alternatives.length > 0 ? alternatives : undefined
    };
}

export function ensureValid(candidate: RankedCandidate, allowInvalid: boolean): void {
    if (candidate.validation.ok || allowInvalid) return;
    throw new WorkflowError(
        ExitCode.InvalidAiOutput,
        `AI output failed validation: ${candidate.validation.reason}`,
        {
            hint: "Regenerate/edit the message or pass --allow-invalid to override."
        }
    );
}

export async function commitMessage(message: string, noVerify: boolean): Promise<void> {
    try {
        await gitCommit(message, { noVerify });
    } catch (error: unknown) {
        throw new WorkflowError(
            ExitCode.GitCommitError,
            normalizeErrorMessage(error, "git commit failed."),
            { hint: "Resolve git hook or repository errors, then retry." }
        );
    }
}

export async function maybeRecordHistory(
    options: ResolvedWorkflowOptions,
    context: RepoContext,
    message: string,
    edited: boolean,
    shouldRecord: boolean
): Promise<void> {
    if (!shouldRecord || options.ci || !options.historyEnabled || !context.historyPath) return;

    try {
        await appendHistory(context.historyPath, {
            createdAt: new Date().toISOString(),
            message,
            edited,
            scope: getMessageScope(message),
            ticket: context.ticket,
            files: context.files
        });
    } catch {
        // History is best-effort and must not block commits.
    }
}

export function getAlternatives(candidates: RankedCandidate[]): string[] {
    return candidates.slice(1).map((candidate) => candidate.message);
}
