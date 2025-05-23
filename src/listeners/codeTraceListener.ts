import * as vscode from "vscode";
import { FlowStorageService } from "./flowStorageService";
import { FlowNode } from "../types/flowTypes";
import { Logger } from "../utilities/logger";

let traceDecorations: vscode.TextEditorDecorationType[] = [];
let currentTraceInterval: NodeJS.Timeout | undefined;

function clearDecorations() {
  traceDecorations.forEach((decoration) => decoration.dispose());
  traceDecorations = [];
  if (currentTraceInterval) {
    clearInterval(currentTraceInterval);
    currentTraceInterval = undefined;
  }
}

async function highlightNode(node: FlowNode, editor: vscode.TextEditor, step: number) {
  if (node.codeReference) {
    const ref = node.codeReference;
    const range = new vscode.Range(
      ref.range.start.line,
      ref.range.start.character,
      ref.range.end.line,
      ref.range.end.character
    );

    const decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: `rgba(0, 255, 0, ${0.5 - step * 0.05})`, // Fades out slightly with more steps
      isWholeLine: false,
      border: "1px solid green",
      overviewRulerColor: "green",
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      light: {
        after: {
          contentText: ` Trace Step: ${step + 1} `,
          color: "black",
          margin: "0 0 0 1em",
          border: "1px solid darkgreen",
          backgroundColor: "lightgreen",
        },
      },
      dark: {
        after: {
          contentText: ` Trace Step: ${step + 1} `,
          color: "white",
          margin: "0 0 0 1em",
          border: "1px solid lightgreen",
          backgroundColor: "darkgreen",
        },
      },
    });
    traceDecorations.push(decorationType);
    editor.setDecorations(decorationType, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

export const traceFlowHandler = async (
  context: vscode.ExtensionContext,
  flowIdFromCommandOrEvent: string | undefined | { flow: { id: string } } | vscode.TreeItem,
  flowStorageService: FlowStorageService
) => {
  clearDecorations();
  let flowIdToTrace: string | undefined = undefined;

  if (typeof flowIdFromCommandOrEvent === "string") {
    flowIdToTrace = flowIdFromCommandOrEvent;
  } else if (flowIdFromCommandOrEvent && typeof flowIdFromCommandOrEvent === "object") {
    // @ts-ignore
    if (flowIdFromCommandOrEvent.flow && typeof flowIdFromCommandOrEvent.flow.id === "string") {
      // @ts-ignore
      flowIdToTrace = flowIdFromCommandOrEvent.flow.id;
    } // @ts-ignore
    else if (typeof flowIdFromCommandOrEvent.id === "string") {
      // @ts-ignore
      flowIdToTrace = flowIdFromCommandOrEvent.id;
    }
  }

  if (!flowIdToTrace) {
    const flows = await flowStorageService.getAllFlows();
    if (!flows || flows.length === 0) {
      vscode.window.showInformationMessage("No flows available to trace.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      flows.map((f) => ({ label: f.name, description: f.description, id: f.id })),
      { placeHolder: "Select a flow to trace" }
    );
    if (picked) {
      flowIdToTrace = picked.id;
    } else {
      return;
    }
  }

  const flow = await flowStorageService.getFlowById(flowIdToTrace);
  if (!flow || !flow.nodes || flow.nodes.length === 0) {
    vscode.window.showErrorMessage("Flow Master: Selected flow has no data to trace.");
    return;
  }

  Logger.log(`Starting trace for flow: ${flow.name}`);
  vscode.window.showInformationMessage(
    `Starting trace for flow: ${flow.name}. Highlighting steps...`
  );

  // Simple sequential trace for now. A real tracer would follow edges and logic.
  let step = 0;
  const sortedNodes = flow.nodes; // This should ideally be a topological sort or follow a main path from edges

  // Find the active editor or open the first relevant file
  let currentEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  if (
    sortedNodes[0]?.codeReference &&
    (!currentEditor || currentEditor.document.uri.fsPath !== sortedNodes[0].codeReference.filePath)
  ) {
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(sortedNodes[0].codeReference.filePath)
      );
      currentEditor = await vscode.window.showTextDocument(doc);
    } catch (e) {
      Logger.error("Could not open document for tracing:", e);
      vscode.window.showErrorMessage("Could not open the starting file for tracing.");
      return;
    }
  }
  if (!currentEditor) {
    vscode.window.showErrorMessage("No active editor to trace in.");
    return;
  }

  currentTraceInterval = setInterval(async () => {
    if (step >= sortedNodes.length) {
      clearDecorations();
      vscode.window.showInformationMessage(`Trace finished for flow: ${flow.name}`);
      return;
    }

    const node = sortedNodes[step];
    if (node.codeReference && currentEditor?.document.uri.fsPath !== node.codeReference.filePath) {
      // Switch editor if node is in a different file
      try {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(node.codeReference.filePath)
        );
        currentEditor = await vscode.window.showTextDocument(doc, {
          preview: false,
          preserveFocus: false,
        });
      } catch (e) {
        Logger.error("Could not switch document for tracing node:", e);
        step++; // Skip this node if file cannot be opened
        return;
      }
    }

    if (currentEditor) {
      await highlightNode(node, currentEditor, step);
    }
    step++;
  }, 1500); // Highlight every 1.5 seconds

  context.subscriptions.push({ dispose: clearDecorations }); // Ensure decorations are cleared on deactivate
};
