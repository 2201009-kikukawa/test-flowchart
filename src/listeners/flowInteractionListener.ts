import * as vscode from "vscode";
import { GraphViewProvider } from "../providers/GraphViewProvider";
import { FlowStorageService } from "./flowStorageService";
import { Logger } from "../utilities/logger";

export const viewFlowHandler = async (
  flowIdFromCommandOrEvent: string | undefined | { flow: { id: string } } | vscode.TreeItem, // Can come from command palette, tree item click, or other events
  graphViewProvider: GraphViewProvider,
  flowStorageService: FlowStorageService // Added to potentially fetch flow if needed, though provider should handle it
) => {
  let flowIdToView: string | undefined = undefined;

  if (typeof flowIdFromCommandOrEvent === "string") {
    flowIdToView = flowIdFromCommandOrEvent;
  } else if (flowIdFromCommandOrEvent && typeof flowIdFromCommandOrEvent === "object") {
    // Check if it's a FlowTreeItem (or similar custom tree item that has a 'flow' property)
    // @ts-ignore // Assuming our tree item has a flow.id
    if (flowIdFromCommandOrEvent.flow && typeof flowIdFromCommandOrEvent.flow.id === "string") {
      // @ts-ignore
      flowIdToView = flowIdFromCommandOrEvent.flow.id;
    } // @ts-ignore // Or if the argument itself is the flow ID directly (from command palette with args)
    else if (typeof flowIdFromCommandOrEvent.id === "string") {
      // @ts-ignore
      flowIdToView = flowIdFromCommandOrEvent.id;
    }
  }

  if (!flowIdToView) {
    // Prompt user to select a flow if no ID is provided (e.g., command from palette)
    const flows = await flowStorageService.getAllFlows();
    if (!flows || flows.length === 0) {
      vscode.window.showInformationMessage("No flows available to view.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      flows.map((f) => ({ label: f.name, description: f.description, id: f.id })),
      { placeHolder: "Select a flow to view" }
    );
    if (picked) {
      flowIdToView = picked.id;
    } else {
      return; // User cancelled
    }
  }

  Logger.log(`FlowInteractionListener: viewFlowHandler called for flow ID: ${flowIdToView}`);
  if (flowIdToView) {
    // Ensure the view is visible/focused.
    // This will also trigger resolveWebviewView if it hasn't been resolved yet.
    await vscode.commands.executeCommand(`${GraphViewProvider.viewType}.focus`);
    graphViewProvider.showFlow(flowIdToView);
  } else {
    Logger.error("FlowInteractionListener: No flow ID provided or selected to view.");
    // Optionally, clear the view or show a default message via graphViewProvider
    graphViewProvider.showFlow(undefined);
  }
};

export const jumpToCodeHandler = async (filePath: string, rangeData: any) => {
  try {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);

    // Ensure rangeData is in the correct vscode.Range format
    const range = new vscode.Range(
      new vscode.Position(rangeData.start.line, rangeData.start.character),
      new vscode.Position(rangeData.end.line, rangeData.end.character)
    );

    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    Logger.log(`Jumped to code: ${filePath} at L${range.start.line + 1}`);
  } catch (error) {
    Logger.error("Error jumping to code:", error);
    vscode.window.showErrorMessage(`Flow Master: Could not open or find file ${filePath}.`);
  }
};
