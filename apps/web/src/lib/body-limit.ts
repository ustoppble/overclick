/**
 * Reads a request body with a ceiling, for the endpoints that take input from
 * callers nobody has vouched for yet (the pairing code, the GitHub webhook,
 * the MCP door).
 *
 * `request.text()` buffers whatever the client sends, so one request can cost
 * as much memory as the client cares to send. Two cuts, in order: a declared
 * Content-Length over the cap is refused before a byte is read, and a body
 * with no (or a wrong) Content-Length, which is what chunked uploads are, is
 * read chunk by chunk and abandoned the moment it passes the cap.
 */
export type BodyRead =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 413 };

/** Content-Length that is a plain non-negative integer, or null when absent; NaN-free. */
function declaredLength(request: Request): number | null | "malformed" {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d{1,15}$/.test(raw.trim())) return "malformed";
  return Number(raw.trim());
}

/** The cheap half, for a caller that wants to refuse before it spends anything else. */
export function declaredTooLarge(request: Request, maxBytes: number): BodyRead | null {
  const length = declaredLength(request);
  if (length === "malformed") return { ok: false, status: 400 };
  if (length !== null && length > maxBytes) return { ok: false, status: 413 };
  return null;
}

export async function readBodyCapped(request: Request, maxBytes: number): Promise<BodyRead> {
  const refused = declaredTooLarge(request, maxBytes);
  if (refused) return refused;
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text: text + decoder.decode() };
}
