import assert from "node:assert/strict";
import { test } from "node:test";
import { PlatformError } from "../../src/lib/errors.js";
import { unwrapCbmJson } from "../../src/lib/graph/cbm-client.js";

test("unwrapCbmJson prefers structuredContent object", () => {
  const body = unwrapCbmJson(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ groups: [] }) }],
      structuredContent: { groups: [{ prefix: "a", rows: [{ name: "N" }] }] },
      isError: false,
    }),
  );
  assert.deepEqual(body, { groups: [{ prefix: "a", rows: [{ name: "N" }] }] });
});

test("unwrapCbmJson parses content[0].text when structuredContent is missing", () => {
  const body = unwrapCbmJson(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ status: "indexed", name: "x" }) }],
      isError: false,
    }),
  );
  assert.deepEqual(body, { status: "indexed", name: "x" });
});

test("unwrapCbmJson treats already-unwrapped body as body", () => {
  const body = unwrapCbmJson(JSON.stringify({ status: "indexed", nodes: 1 }));
  assert.deepEqual(body, { status: "indexed", nodes: 1 });
});

test("unwrapCbmJson isError timeout becomes graph_timeout", () => {
  assert.throws(
    () =>
      unwrapCbmJson(
        JSON.stringify({
          content: [{ type: "text", text: "timed out after 600s" }],
          isError: true,
        }),
      ),
    (err: unknown) => err instanceof PlatformError && err.code === "graph_timeout",
  );
});

test("unwrapCbmJson isError becomes graph_unavailable", () => {
  assert.throws(
    () =>
      unwrapCbmJson(
        JSON.stringify({
          content: [{ type: "text", text: "no project" }],
          isError: true,
        }),
      ),
    (err: unknown) => err instanceof PlatformError && err.code === "graph_unavailable",
  );
});
