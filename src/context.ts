function normalizePathPrefix(value: string): string {
    return value.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
}

function findMappedScope(
    file: string,
    scopeMap: Record<string, string>
): string | null {
    const normalizedFile = normalizePathPrefix(file);
    let bestMatch: string | null = null;
    let bestMatchRaw: string | null = null;

    for (const rawPrefix of Object.keys(scopeMap)) {
        const prefix = normalizePathPrefix(rawPrefix);
        if (!prefix) continue;
        if (normalizedFile !== prefix && !normalizedFile.startsWith(`${prefix}/`)) continue;
        if (!bestMatch || prefix.length > bestMatch.length) {
            bestMatch = prefix;
            bestMatchRaw = rawPrefix;
        }
    }

    return bestMatchRaw ? scopeMap[bestMatchRaw] ?? null : null;
}

export function inferScopeFromFiles(files: string[], scopeMap: Record<string, string> = {}): string | null {
    if (files.length === 0) return null;

    if (Object.keys(scopeMap).length > 0) {
        const mappedCounts = new Map<string, number>();
        for (const file of files) {
            const scope = findMappedScope(file, scopeMap);
            if (!scope) continue;
            mappedCounts.set(scope, (mappedCounts.get(scope) ?? 0) + 1);
        }

        let bestMappedScope: string | null = null;
        let bestMappedCount = 0;
        for (const [scope, count] of mappedCounts.entries()) {
            if (count > bestMappedCount) {
                bestMappedScope = scope;
                bestMappedCount = count;
            }
        }

        if (bestMappedScope && bestMappedCount / files.length >= 0.6) {
            return bestMappedScope;
        }
    }

    const counts = new Map<string, number>();
    for (const file of files) {
        const normalized = normalizePathPrefix(file);
        const slashIndex = normalized.indexOf("/");
        if (slashIndex <= 0) continue;

        const scope = normalized.slice(0, slashIndex);
        counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }

    let bestScope: string | null = null;
    let bestCount = 0;
    for (const [scope, count] of counts.entries()) {
        if (count > bestCount) {
            bestScope = scope;
            bestCount = count;
        }
    }

    if (!bestScope) return null;
    return bestCount / files.length >= 0.6 ? bestScope : null;
}

export function inferTicketFromBranch(
    branch: string | null,
    pattern: string
): string | null {
    if (!branch) return null;

    const match = branch.match(new RegExp(pattern));
    if (!match) return null;

    const ticket = match[1] ?? match[0];
    return ticket.trim() || null;
}
