import assert from "node:assert/strict";
import { test } from "node:test";
import { flattenGroups, isIdentifierQuery, parseProjectPage } from "../../src/lib/graph/parse.js";

test("flattenGroups maps object rows with prefix qn and line range", () => {
  const hits = flattenGroups({
    groups: [
      {
        prefix: "demo.src.http",
        file: "src/http.ts",
        rows: [{ name: "HandleRequest", label: "Function", lines: "42-80" }],
      },
    ],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.name, "HandleRequest");
  assert.equal(hits[0]?.path, "src/http.ts");
  assert.equal(hits[0]?.line, 42);
  assert.equal(hits[0]?.qn, "demo.src.http.HandleRequest");
});

test("flattenGroups maps tuple rows with default columns", () => {
  const hits = flattenGroups({
    groups: [{ prefix: "pkg", rows: [["Foo", "Function", "9-10", "1", "0"]] }],
  });
  assert.equal(hits[0]?.name, "Foo");
  assert.equal(hits[0]?.label, "Function");
  assert.equal(hits[0]?.line, 9);
  assert.equal(hits[0]?.qn, "pkg.Foo");
});

test("flattenGroups returns empty on missing keys", () => {
  assert.deepEqual(flattenGroups({}), []);
  assert.deepEqual(flattenGroups(null), []);
});

test("flattenGroups bucket callers", () => {
  const hits = flattenGroups(
    {
      callers: {
        groups: [{ file: "a.ts", rows: [{ name: "Caller", label: "Function" }] }],
      },
    },
    "callers",
  );
  assert.equal(hits[0]?.name, "Caller");
  assert.equal(hits[0]?.path, "a.ts");
});

test("parseProjectPage skips rows without root_path", () => {
  const page = parseProjectPage({
    projects: [{ name: "skip-me" }, { name: "keep", root_path: "/tmp/r" }],
    has_more: false,
  });
  assert.equal(page.projects.length, 1);
  assert.equal(page.projects[0]?.name, "keep");
});

test("identifier query vs BM25", () => {
  assert.equal(isIdentifierQuery("HandleRequest"), true);
  assert.equal(isIdentifierQuery("src.http.HandleRequest"), true);
  assert.equal(isIdentifierQuery("twitter webhook"), false);
});
