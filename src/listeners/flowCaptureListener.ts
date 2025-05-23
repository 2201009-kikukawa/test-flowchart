import * as vscode from "vscode";
import { AstService } from "../utilities/astService";
import { FlowStorageService } from "./flowStorageService";
import { CapturedFlow, CodeReference, FlowNode, FlowEdge } from "../types/flowTypes";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "../utilities/logger";
import { GraphViewProvider } from "../providers/GraphViewProvider";
import { FlowListProvider } from "../providers/FlowListProvider";

interface Pin {
  filePath: string;
  position: vscode.Position;
  selection: vscode.Selection;
  identifier?: string; // e.g., function name
}

export class FlowCaptureService {
  private context: vscode.ExtensionContext;
  private astService: AstService;
  private storageService: FlowStorageService;
  private startPin: Pin | undefined;
  private endPin: Pin | undefined;

  constructor(
    context: vscode.ExtensionContext,
    astService: AstService,
    storageService: FlowStorageService
  ) {
    this.context = context;
    this.astService = astService;
    this.storageService = storageService;
  }

  private createCodeReferenceFromPin(pin: Pin): CodeReference {
    return {
      filePath: pin.filePath,
      range: {
        start: { line: pin.selection.start.line, character: pin.selection.start.character },
        end: { line: pin.selection.end.line, character: pin.selection.end.character },
      },
      identifier: pin.identifier,
    };
  }

  public async setStartPin() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a file and select a start point.");
      return;
    }
    const identifier = await this.astService.getFunctionNameAtCursor(
      editor.document.uri.fsPath,
      editor.selection.active
    );
    this.startPin = {
      filePath: editor.document.uri.fsPath,
      position: editor.selection.active,
      selection: editor.selection,
      identifier: identifier,
    };
    vscode.window.showInformationMessage(
      `Flow Start Pin set at: ${path.basename(this.startPin.filePath)} line ${
        this.startPin.position.line + 1
      }${this.startPin.identifier ? ` (in ${this.startPin.identifier})` : ""}`
    );
    Logger.log("Start Pin set:", this.startPin);
    this.updateCanSaveFlowContext();
  }

  public async setEndPin() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a file and select an end point.");
      return;
    }
    const identifier = await this.astService.getFunctionNameAtCursor(
      editor.document.uri.fsPath,
      editor.selection.active
    );
    this.endPin = {
      filePath: editor.document.uri.fsPath,
      position: editor.selection.active,
      selection: editor.selection,
      identifier: identifier,
    };
    vscode.window.showInformationMessage(
      `Flow End Pin set at: ${path.basename(this.endPin.filePath)} line ${
        this.endPin.position.line + 1
      }${this.endPin.identifier ? ` (in ${this.endPin.identifier})` : ""}`
    );
    Logger.log("End Pin set:", this.endPin);
    this.updateCanSaveFlowContext();
  }

  private updateCanSaveFlowContext() {
    const canSave = !!(this.startPin && this.endPin);
    vscode.commands.executeCommand("setContext", "flowMaster.canSaveFlow", canSave);
  }

  public hasPinsSet(): boolean {
    return !!this.startPin && !!this.endPin;
  }

  public async captureFlow(): Promise<Partial<CapturedFlow> | undefined> {
    if (!this.startPin) {
      vscode.window.showErrorMessage("Flow Master: Start pin not set.");
      return undefined;
    }
    // If only start pin is set, try to parse that function.
    // If both are set, parse the range or the functions.

    let flowName = `Flow from ${path.basename(this.startPin.filePath)}`;
    let nodes: FlowNode[] = [];
    let edges: FlowEdge[] = [];
    let parsedData;

    if (this.startPin && this.endPin) {
      // Simple case: if pins are in the same file and start is before end
      if (
        this.startPin.filePath === this.endPin.filePath &&
        this.startPin.position.isBeforeOrEqual(this.endPin.position)
      ) {
        flowName = `Flow in ${path.basename(this.startPin.filePath)} (${
          this.startPin.identifier || `L${this.startPin.selection.start.line + 1}`
        } to ${this.endPin.identifier || `L${this.endPin.selection.end.line + 1}`})`;
        parsedData = await this.astService.parseFunctionCalls(
          this.startPin.filePath,
          undefined, // No single function name, parse range
          this.startPin.selection.start.line + 1,
          this.endPin.selection.end.line + 1
        );
      } else {
        // More complex: different files or non-linear selection.
        // For now, we can parse the start pin's function and then the end pin's function separately,
        // and the user can manually link them or we can attempt a smarter connection later.
        // This part needs significant expansion for true multi-file/complex range analysis.
        vscode.window.showWarningMessage(
          "Flow Master: Cross-file or complex range capture is currently limited. Capturing start pin's context."
        );
        flowName = `Flow starting at ${
          this.startPin.identifier || path.basename(this.startPin.filePath)
        }`;
        parsedData = await this.astService.parseFunctionCalls(
          this.startPin.filePath,
          this.startPin.identifier, // Parse the function at start pin
          this.startPin.selection.start.line + 1
        );
      }
    } else if (this.startPin) {
      // Only start pin is set
      flowName = `Flow for ${this.startPin.identifier || path.basename(this.startPin.filePath)}`;
      parsedData = await this.astService.parseFunctionCalls(
        this.startPin.filePath,
        this.startPin.identifier,
        this.startPin.selection.start.line + 1 // Provide line for better context if name is ambiguous
      );
    }

    if (parsedData) {
      nodes = parsedData.nodes;
      edges = parsedData.edges;
    }

    if (nodes.length === 0 && this.startPin) {
      // If parsing failed to find specific calls but we have a pin, create at least an entry node
      const entryNodeId = uuidv4();
      nodes.push({
        id: entryNodeId,
        label: this.startPin.identifier || `Selection in ${path.basename(this.startPin.filePath)}`,
        type: this.startPin.identifier ? "EntryPoint" : "ManualStep",
        codeReference: this.createCodeReferenceFromPin(this.startPin),
        description: `Selected entry for the flow.`,
      });
      if (this.endPin) {
        const endNodeId = uuidv4();
        nodes.push({
          id: endNodeId,
          label: this.endPin.identifier || `Selection in ${path.basename(this.endPin.filePath)}`,
          type: this.endPin.identifier ? "ExitPoint" : "ManualStep",
          codeReference: this.createCodeReferenceFromPin(this.endPin),
          description: `Selected exit for the flow.`,
        });
        if (nodes.length >= 2) {
          edges.push({ id: uuidv4(), from: nodes[0].id, to: nodes[1].id, type: "DirectCall" });
        }
      }
    }

    return {
      name: flowName,
      description: "", // User will fill this
      category: "General",
      tags: [],
      startPin: this.startPin ? this.createCodeReferenceFromPin(this.startPin) : undefined,
      endPin: this.endPin ? this.createCodeReferenceFromPin(this.endPin) : undefined,
      nodes,
      edges,
    };
  }

  public clearPins() {
    this.startPin = undefined;
    this.endPin = undefined;
    this.updateCanSaveFlowContext();
    Logger.log("Pins cleared.");
  }

  public async saveCurrentFlow(
    details: Partial<CapturedFlow>,
    graphViewProvider: GraphViewProvider,
    flowListProvider: FlowListProvider
  ) {
    if (!details.nodes || details.nodes.length === 0) {
      vscode.window.showErrorMessage(
        "Flow Master: Cannot save an empty flow. Please ensure pins are set and code is parsable."
      );
      return;
    }

    const flowToSave: Omit<CapturedFlow, "id" | "createdAt" | "updatedAt"> = {
      name: details.name || "Untitled Flow",
      description: details.description || "",
      category: details.category || "General",
      tags: details.tags || [],
      startPin: details.startPin,
      endPin: details.endPin,
      nodes: details.nodes,
      edges: details.edges || [],
      author: "Current User", // Placeholder, could get git username or VSCode user
    };

    const savedFlow = await this.storageService.saveFlow(flowToSave);
    vscode.window.showInformationMessage(`Flow "${savedFlow.name}" saved.`);
    this.clearPins();

    // Refresh sidebar and potentially update webview
    flowListProvider.refresh();
    graphViewProvider.showFlow(savedFlow.id); // Display the newly saved flow
  }
}

export const setFlowStartPinHandler = (flowCaptureService: FlowCaptureService) => {
  flowCaptureService.setStartPin();
};

export const setFlowEndPinHandler = (flowCaptureService: FlowCaptureService) => {
  flowCaptureService.setEndPin();
};

import * as path from "path"; // Add this at the top if not already there

export const saveFlowHandler = async (
  flowCaptureService: FlowCaptureService,
  graphViewProvider: GraphViewProvider,
  flowListProvider: FlowListProvider
) => {
  if (!flowCaptureService.hasPinsSet()) {
    // Try to use current selection or function if no pins are explicitly set
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await flowCaptureService.setStartPin(); // Set start pin from current selection/cursor
      // Optionally, if a large selection, set end pin too, or let captureFlow handle single pin case.
      // For simplicity, we'll proceed assuming captureFlow can handle a single (start) pin.
    } else {
      vscode.window.showErrorMessage(
        "Flow Master: Please set start and end pins or select a function in the editor."
      );
      return;
    }
  }

  const capturedData = await flowCaptureService.captureFlow();
  if (!capturedData || !capturedData.nodes || capturedData.nodes.length === 0) {
    vscode.window.showInformationMessage(
      "Flow Master: Could not capture a flow from the current selection or pins. Ensure the code is parsable and pins are set correctly."
    );
    flowCaptureService.clearPins();
    return;
  }

  const flowName = await vscode.window.showInputBox({
    prompt: "Enter a name for this flow",
    value: capturedData.name || "Untitled Flow",
  });
  if (!flowName) return; // User cancelled

  const flowDescription = await vscode.window.showInputBox({
    prompt: "Enter a description for this flow (optional)",
  });

  const categories = [
    "General",
    "User Interaction",
    "Data Processing",
    "API Call",
    "Authentication",
    "Needs Review",
  ] as const;
  const selectedCategory = await vscode.window.showQuickPick(categories, {
    placeHolder: "Select a category (optional)",
  });

  const tagsInput = await vscode.window.showInputBox({
    prompt: "Enter tags, comma-separated (e.g., critical, frontend) (optional)",
  });
  const tags = tagsInput
    ? tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t)
    : [];

  capturedData.name = flowName;
  capturedData.description = flowDescription || "";
  capturedData.category = (selectedCategory as typeof categories[number]) || "General";
  capturedData.tags = tags;

  await flowCaptureService.saveCurrentFlow(capturedData, graphViewProvider, flowListProvider);
};
