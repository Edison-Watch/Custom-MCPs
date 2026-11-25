import { describe, expect, it } from "bun:test";

import { boundRequestBody } from "./body";

const URL_ = "https://example.com/mcp";

function streamed(bytes: number): Request {
  // A chunked body with no Content-Length, so only the read loop can catch it.
  const chunk = new Uint8Array(1024).fill(120);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const n = Math.min(chunk.byteLength, bytes - sent);
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
    },
  });
  return new Request(URL_, { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("boundRequestBody", () => {
  it("passes a body at the limit through intact", async () => {
    const out = await boundRequestBody(new Request(URL_, { method: "POST", body: "x".repeat(10) }), 10);
    expect(out).toBeInstanceOf(Request);
    expect(await (out as Request).text()).toBe("x".repeat(10));
    expect((out as Request).headers.get("content-length")).toBeNull();
  });

  it("413s a body one byte over, as JSON-RPC", async () => {
    const out = await boundRequestBody(new Request(URL_, { method: "POST", body: "x".repeat(11) }), 10);
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(413);
    expect(((await (out as Response).json()) as { error: { message: string } }).error.message).toContain("10 bytes");
  });

  it("413s a streamed body with no Content-Length on the bytes read", async () => {
    const out = await boundRequestBody(streamed(5000), 4096);
    expect((out as Response).status).toBe(413);
  });

  it("keeps headers and leaves non-POST requests untouched", async () => {
    const post = new Request(URL_, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    expect(((await boundRequestBody(post, 10)) as Request).headers.get("authorization")).toBe("Bearer t");
    const get = new Request(URL_);
    expect(await boundRequestBody(get, 0)).toBe(get);
  });
});
