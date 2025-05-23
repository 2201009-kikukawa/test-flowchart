import * as vscode from "vscode";
import { GraphViewProvider } from "./providers/GraphViewProvider";
import { FlowListProvider } from "./providers/FlowListProvider";
import {
  setFlowStartPinHandler,
  setFlowEndPinHandler,
  saveFlowHandler,
  FlowCaptureService,
} from "./listeners/flowCaptureListener";
import { viewFlowHandler, jumpToCodeHandler } from "./listeners/flowInteractionListener";
import { traceFlowHandler } from "./listeners/codeTraceListener";
import {
  exportFlowSVGHandler,
  exportFlowPNGHandler,
  exportFlowMarkdownHandler,
} from "./listeners/exportListener";
import { FlowStorageService } from "./listeners/flowStorageService";
import { AstService } from "./utilities/astService";
import { Logger } from "./utilities/logger";

let flowCaptureService: FlowCaptureService;

export function activate(context: vscode.ExtensionContext) {
  Logger.init(context);
  Logger.log("Flow Master extension is now active!");

  const astService = new AstService();
  const flowStorageService = new FlowStorageService(context);
  flowCaptureService = new FlowCaptureService(context, astService, flowStorageService);

  // Graph View Provider
  const graphViewProvider = new GraphViewProvider(
    context.extensionUri,
    context,
    flowStorageService
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphViewProvider.viewType, graphViewProvider)
  );
  Logger.log("GraphViewProvider registered.");

  // Flow List Sidebar Provider
  const flowListProvider = new FlowListProvider(context, flowStorageService);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("flowMaster.flowListSidebar", flowListProvider)
  );
  Logger.log("FlowListProvider registered.");

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("flowMaster.setFlowStartPin", () =>
      setFlowStartPinHandler(flowCaptureService)
    ),
    vscode.commands.registerCommand("flowMaster.setFlowEndPin", () =>
      setFlowEndPinHandler(flowCaptureService)
    ),
    vscode.commands.registerCommand("flowMaster.saveFlow", () =>
      saveFlowHandler(flowCaptureService, graphViewProvider, flowListProvider)
    ),
    vscode.commands.registerCommand("flowMaster.viewFlow", (flowId?: string) =>
      viewFlowHandler(flowId, graphViewProvider, flowStorageService)
    ),
    vscode.commands.registerCommand(
      "flowMaster.jumpToCode",
      (filePath: string, range: vscode.Range) => jumpToCodeHandler(filePath, range)
    ),
    vscode.commands.registerCommand("flowMaster.traceFlow", (flowId?: string) =>
      traceFlowHandler(context, flowId, flowStorageService)
    ),
    vscode.commands.registerCommand("flowMaster.exportFlowSVG", (flowId?: string) =>
      exportFlowSVGHandler(flowId, flowStorageService, graphViewProvider)
    ),
    vscode.commands.registerCommand("flowMaster.exportFlowPNG", (flowId?: string) =>
      exportFlowPNGHandler(flowId, flowStorageService, graphViewProvider)
    ),
    vscode.commands.registerCommand("flowMaster.exportFlowMarkdown", (flowId?: string) =>
      exportFlowMarkdownHandler(flowId, flowStorageService, graphViewProvider)
    ),
    vscode.commands.registerCommand("flowMaster.refreshFlowList", () => flowListProvider.refresh())
  );
  Logger.log("Commands registered.");

  // Listen to configuration changes for the shared flows file
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("flowMaster.sharedFlowsFile")) {
        flowStorageService.updateFlowsFilePath();
        flowListProvider.refresh();
        // Potentially notify webview if it's open and displaying a flow from the old path
      }
    })
  );

  // File watcher for the flows.json file
  flowStorageService.createFlowsFileWatcher(flowListProvider);
  Logger.log("Flows file watcher created.");

  // Set initial context for when flow can be saved
  vscode.commands.executeCommand("setContext", "flowMaster.canSaveFlow", false);
}

export function deactivate() {
  Logger.log("Flow Master extension deactivated.");
}
