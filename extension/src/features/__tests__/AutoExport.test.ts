import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref, Stream, TestClock } from "effect";
import type * as vscode from "vscode";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { createNotebookUri, TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { LanguageClient } from "../../lsp/LanguageClient.ts";
import { VsCode } from "../../platform/VsCode.ts";
import { AutoExportLive, getAutoExportPaths } from "../AutoExport.ts";

const withTestCtx = Effect.fn(function* (
  configuration: Record<string, unknown> = {},
) {
  const fileSystem = new Map<string, Uint8Array | Error>();
  const commands = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
    data: {
      cells: [
        {
          kind: 2,
          value: "import marimo as mo\nmo.md('# hello')",
          languageId: "mo-python",
          metadata: { stableId: "cell-1" },
        },
      ],
    },
  });
  const vscode = yield* TestVsCode.make({
    configuration,
    fileSystem,
    initialDocuments: [editor.notebook],
  });

  const layer = Layer.empty.pipe(
    Layer.provideMerge(AutoExportLive),
    Layer.provideMerge(vscode.layer),
    Layer.provide(TestTelemetryLive),
    Layer.provide(
      Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          channel: { name: "marimo-lsp", show() {} },
          restart: () => Effect.void,
          executeCommand(cmd) {
            const method =
              "method" in cmd.params ? cmd.params.method : undefined;
            return Ref.update(commands, (arr) => [...arr, cmd]).pipe(
              Effect.as(
                method === "export-as-html"
                  ? "<html>hello</html>"
                  : '{"cells":[]}',
              ),
            );
          },
          streamOf() {
            return Stream.never;
          },
        }),
      ),
    ),
  );

  return { commands, editor, fileSystem, layer, vscode };
});

function outputChangeEvent(
  notebook: vscode.NotebookDocument,
): vscode.NotebookDocumentChangeEvent {
  return {
    notebook,
    cellChanges: [
      {
        cell: notebook.cellAt(0),
        document: undefined,
        executionSummary: undefined,
        metadata: undefined,
        outputs: [],
      },
    ],
    contentChanges: [],
    metadata: undefined,
  };
}

describe("AutoExport", () => {
  it.effect(
    "builds export paths next to the notebook",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const paths = getAutoExportPaths(
          code,
          createNotebookUri("/test/notebook.py"),
        );

        expect(paths.directory.path).toBe("/test/__marimo__");
        expect(paths.html.path).toBe("/test/__marimo__/notebook.html");
        expect(paths.ipynb.path).toBe("/test/__marimo__/notebook.ipynb");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "does not export when auto-export is disabled",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 millis");
        yield* ctx.vscode.notebookChange(
          outputChangeEvent(ctx.editor.notebook),
        );
        yield* TestClock.adjust("2 seconds");

        expect(yield* ctx.commands).toEqual([]);
        expect(ctx.fileSystem.size).toBe(0);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "exports enabled formats into __marimo__ after output changes",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx({
        "marimo.export.autoHtml": true,
        "marimo.export.autoIpynb": true,
        "marimo.export.autoDelayMs": 10,
      });

      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 millis");
        yield* ctx.vscode.notebookChange(
          outputChangeEvent(ctx.editor.notebook),
        );
        yield* TestClock.adjust("2 seconds");

        const decoder = new TextDecoder();
        expect(
          readFileText(
            decoder,
            ctx.fileSystem,
            "file:///test/__marimo__/notebook.html",
          ),
        ).toBe("<html>hello</html>");
        expect(
          readFileText(
            decoder,
            ctx.fileSystem,
            "file:///test/__marimo__/notebook.ipynb",
          ),
        ).toBe('{"cells":[]}');
        expect(yield* ctx.commands).toMatchInlineSnapshot(`
          [
            {
              "command": "marimo.api",
              "params": {
                "method": "export-as-html",
                "params": {
                  "inner": {
                    "assetUrl": null,
                    "download": false,
                    "files": [],
                    "includeCode": true,
                  },
                  "notebookUri": "file:///test/notebook.py",
                },
              },
            },
            {
              "command": "marimo.api",
              "params": {
                "method": "export-as-ipynb",
                "params": {
                  "inner": {},
                  "notebookUri": "file:///test/notebook.py",
                },
              },
            },
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});

function readFileText(
  decoder: TextDecoder,
  fileSystem: Map<string, Uint8Array | Error>,
  key: string,
) {
  const entry = fileSystem.get(key);
  expect(entry).toBeInstanceOf(Uint8Array);
  return entry instanceof Uint8Array ? decoder.decode(entry) : "";
}
