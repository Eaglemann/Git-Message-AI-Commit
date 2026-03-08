import { afterEach, describe, expect, it, vi } from "vitest";
import { ollamaChat, ensureLocalModel, OllamaError } from "../../src/ollama.js";

describe("ollama helpers", () => {
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("retries chat on transient server errors", async () => {
        let attempts = 0;
        vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string | URL) => {
            if (String(url).endsWith("/api/chat")) {
                attempts += 1;
                if (attempts < 3) {
                    return new Response("temporary failure", { status: 500 });
                }

                return new Response(JSON.stringify({
                    message: { content: "{\"message\":\"feat: recover after retries\"}" }
                }), {
                    status: 200,
                    headers: { "content-type": "application/json" }
                });
            }

            return new Response(JSON.stringify({
                models: [{ name: "gpt-oss:120b-cloud:latest" }]
            }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }));

        const content = await ollamaChat({
            host: "http://localhost:11434",
            model: "gpt-oss:120b-cloud",
            messages: [{ role: "user", content: "hello" }],
            json: true,
            retries: 2,
            timeoutMs: 2000
        });

        expect(content).toContain("feat: recover after retries");
        expect(attempts).toBe(3);
    });

    it("throws a timeout error when the server is too slow", async () => {
        vi.stubGlobal("fetch", vi.fn().mockImplementation((_: string | URL, init?: RequestInit) => {
            return new Promise<Response>((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve(new Response(JSON.stringify({
                        message: { content: "{\"message\":\"feat: late response\"}" }
                    }), {
                        status: 200,
                        headers: { "content-type": "application/json" }
                    }));
                }, 120);

                init?.signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(new DOMException("Aborted", "AbortError"));
                });
            });
        }));

        await expect(() => ollamaChat({
            host: "http://localhost:11434",
            model: "gpt-oss:120b-cloud",
            messages: [{ role: "user", content: "hello" }],
            json: true,
            retries: 0,
            timeoutMs: 20
        })).rejects.toMatchObject<OllamaError>({ code: "TIMEOUT" });
    });

    it("fails model readiness check when local model is missing", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
            models: [{ name: "mistral:latest" }]
        }), {
            status: 200,
            headers: { "content-type": "application/json" }
        })));

        await expect(() => ensureLocalModel("http://localhost:11434", "gpt-oss:120b-cloud", 1000))
            .rejects
            .toMatchObject<OllamaError>({ code: "MODEL_NOT_FOUND" });
    });
});
