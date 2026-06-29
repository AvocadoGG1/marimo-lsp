import * as NodePath from "node:path";

import {
  Cause,
  Duration,
  Effect,
  Fiber,
  HashMap,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import { LanguageClient } from "../lsp/LanguageClient.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";

const DEFAULT_AUTO_EXPORT_DELAY_MS = 1_000;

interface AutoExportConfig {
  readonly html: boolean;
  readonly ipynb: boolean;
  readonly delayMs: number;
}

type AutoExportFormat = "html" | "ipynb";

export const AutoExportLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const client = yield* LanguageClient;
    const pendingExports = yield* Ref.make(
      HashMap.empty<NotebookId, Fiber.RuntimeFiber<void>>(),
    );

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentChanges().pipe(
        Stream.filterMap((event) =>
          Option.map(
            MarimoNotebookDocument.tryFrom(event.notebook),
            (notebook) => ({
              event,
              notebook,
            }),
          ),
        ),
        Stream.filter(({ event, notebook }) => {
          return (
            isAutoExportTrigger(event) &&
            !notebook.isUntitled &&
            notebook.uri.scheme === "file"
          );
        }),
        Stream.runForEach(
          Effect.fn("AutoExport.schedule")(function* ({ notebook }) {
            const config = yield* readAutoExportConfig(code, notebook.uri);
            if (!config.html && !config.ipynb) {
              return;
            }

            const previous = yield* Ref.modify(pendingExports, (map) => [
              HashMap.get(map, notebook.id),
              HashMap.remove(map, notebook.id),
            ]);

            if (Option.isSome(previous)) {
              yield* Fiber.interrupt(previous.value);
            }

            const fiber = yield* exportAfterDelay({
              client,
              code,
              config,
              notebook,
              pendingExports,
            }).pipe(Effect.forkScoped);

            yield* Ref.update(pendingExports, HashMap.set(notebook.id, fiber));
          }),
        ),
      ),
    );
  }),
);

function isAutoExportTrigger(event: vscode.NotebookDocumentChangeEvent) {
  return event.cellChanges.some((change) => change.outputs !== undefined);
}

const exportAfterDelay = Effect.fn("AutoExport.exportAfterDelay")(function* ({
  client,
  code,
  config,
  notebook,
  pendingExports,
}: {
  readonly client: LanguageClient;
  readonly code: VsCode;
  readonly config: AutoExportConfig;
  readonly notebook: MarimoNotebookDocument;
  readonly pendingExports: Ref.Ref<
    HashMap.HashMap<NotebookId, Fiber.RuntimeFiber<void>>
  >;
}) {
  yield* Effect.sleep(Duration.millis(config.delayMs));
  yield* exportNotebook({ client, code, config, notebook }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning("Failed to auto-export notebook", cause).pipe(
        Effect.annotateLogs({
          notebook: notebook.id,
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );
  yield* Ref.update(pendingExports, HashMap.remove(notebook.id));
});

const exportNotebook = Effect.fn("AutoExport.exportNotebook")(function* ({
  client,
  code,
  config,
  notebook,
}: {
  readonly client: LanguageClient;
  readonly code: VsCode;
  readonly config: AutoExportConfig;
  readonly notebook: MarimoNotebookDocument;
}) {
  const paths = getAutoExportPaths(code, notebook.uri);
  yield* code.workspace.fs.createDirectory(paths.directory);

  if (config.html) {
    const html = yield* requestExport(client, notebook, "html");
    yield* code.workspace.fs.writeFile(
      paths.html,
      new TextEncoder().encode(html),
    );
    yield* Effect.logInfo("Auto-exported notebook as HTML").pipe(
      Effect.annotateLogs({
        notebook: notebook.id,
        output: paths.html.fsPath,
      }),
    );
  }

  if (config.ipynb) {
    const ipynb = yield* requestExport(client, notebook, "ipynb");
    yield* code.workspace.fs.writeFile(
      paths.ipynb,
      new TextEncoder().encode(ipynb),
    );
    yield* Effect.logInfo("Auto-exported notebook as IPYNB").pipe(
      Effect.annotateLogs({
        notebook: notebook.id,
        output: paths.ipynb.fsPath,
      }),
    );
  }
});

function requestExport(
  client: LanguageClient,
  notebook: MarimoNotebookDocument,
  format: AutoExportFormat,
) {
  if (format === "html") {
    return client
      .executeCommand({
        command: "marimo.api",
        params: {
          method: "export-as-html",
          params: {
            notebookUri: notebook.id,
            inner: {
              download: false,
              files: [],
              includeCode: true,
              assetUrl: null,
            },
          },
        },
      })
      .pipe(Effect.andThen(Schema.decodeUnknown(Schema.String)));
  }

  return client
    .executeCommand({
      command: "marimo.api",
      params: {
        method: "export-as-ipynb",
        params: {
          notebookUri: notebook.id,
          inner: {},
        },
      },
    })
    .pipe(Effect.andThen(Schema.decodeUnknown(Schema.String)));
}

function readAutoExportConfig(code: VsCode, scope: vscode.Uri) {
  return Effect.gen(function* () {
    const config = yield* code.workspace.getConfiguration("marimo", scope);
    return {
      html: config.get("export.autoHtml", false),
      ipynb: config.get("export.autoIpynb", false),
      delayMs: normalizeDelayMs(config.get("export.autoDelayMs", undefined)),
    };
  });
}

function normalizeDelayMs(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_AUTO_EXPORT_DELAY_MS;
}

export function getAutoExportPaths(code: VsCode, notebookUri: vscode.Uri) {
  const parsed = NodePath.posix.parse(notebookUri.path);
  const stem = parsed.name;
  const directory = code.Uri.joinPath(
    notebookUri.with({ path: parsed.dir }),
    "__marimo__",
  );

  return {
    directory,
    html: code.Uri.joinPath(directory, `${stem}.html`),
    ipynb: code.Uri.joinPath(directory, `${stem}.ipynb`),
  };
}
