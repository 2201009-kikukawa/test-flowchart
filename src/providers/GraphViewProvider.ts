import * as //
vscode from "vscode";
import { getUri } from "../utilities/getUri"; //
import { getNonce } from "../utilities/getNonce"; //
import {
  CapturedFlow,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from "../types/flowTypes";
import { FlowStorageService } from "../listeners/flowStorageService";
import { Logger } from "../utilities/logger";

export class GraphViewProvider implements vscode.WebviewViewProvider {
  //
  public static readonly viewType = "flowMaster.graphView"; // Updated ID
  private _webviewView?: vscode.WebviewView;
  private _currentFlowId?: string;

  constructor(
    private readonly _extensionUri: vscode.Uri, //
    private readonly _context: vscode.ExtensionContext,
    private readonly _flowStorageService: FlowStorageService
  ) {}

  public resolveWebviewView(
    //
    webviewView: vscode.WebviewView, //
    _context: vscode.WebviewViewResolveContext, //
    _token: vscode.CancellationToken //
  ): void | Thenable<void> {
    this._webviewView = webviewView;

    webviewView.webview.options = {
      //
      enableScripts: true, //
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "out"), //
        vscode.Uri.joinPath(this._extensionUri, "node_modules", "mermaid", "dist"), // For mermaid.min.js
      ],
    };

    webviewView.webview.html = this._getWebviewContent(webviewView.webview); //

    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      Logger.log("GraphViewProvider received message from webview:", message);
      switch (message.command) {
        case "webviewReady":
          Logger.log("Webview reported ready. Sending initial data if a flow is loaded.");
          if (this._currentFlowId) {
            this.showFlow(this._currentFlowId); // Resend if webview reloads
          } else {
            // Send a default or empty state if no flow is selected
            this.postMessageToWebview({ command: "showFlow", payload: null });
          }
          break;
        case "jumpToCode":
          if (message.payload && message.payload.filePath && message.payload.range) {
            vscode.commands.executeCommand(
              "flowMaster.jumpToCode",
              message.payload.filePath,
              message.payload.range
            );
          }
          break;
        case "getFlowData": // Webview requests data for a specific flow (e.g. on init)
          if (message.payload && message.payload.flowId) {
            this.showFlow(message.payload.flowId);
          } else if (this._currentFlowId) {
            // Or resend current if no specific ID
            this.showFlow(this._currentFlowId);
          }
          break;
        case "updateFlowMetadata": // User updated metadata in webview
          if (message.payload && message.payload.flow) {
            const updatedFlow = message.payload.flow as CapturedFlow;
            await this._flowStorageService.updateFlow(updatedFlow);
            vscode.commands.executeCommand("flowMaster.refreshFlowList"); // Refresh sidebar
            vscode.window.showInformationMessage(`Flow "${updatedFlow.name}" metadata updated.`);
          }
          break;
        // Add more cases as needed
      }
    });

    webviewView.onDidDispose(() => {
      this._webviewView = undefined;
    });

    // For testing, load a mock flow or a default view
    // this.showFlow(MOCK_FLOW_ID); // Or leave it blank until a flow is selected
  }

  public async showFlow(flowId: string | undefined) {
    if (!flowId) {
      this._currentFlowId = undefined;
      this.postMessageToWebview({ command: "showFlow", payload: null });
      Logger.log("GraphViewProvider: Cleared flow display.");
      return;
    }

    this._currentFlowId = flowId;
    if (!this._webviewView) {
      // Webview not ready yet, command will be re-triggered or handled by webviewReady
      Logger.error("GraphViewProvider: Webview not ready when showFlow was called for ID:", flowId);
      // Trigger the view to show, which will then call resolveWebviewView
      vscode.commands.executeCommand(`${GraphViewProvider.viewType}.focus`);
      return;
    }

    Logger.log(`GraphViewProvider: Attempting to show flow with ID: ${flowId}`);
    try {
      const flow = await this._flowStorageService.getFlowById(flowId);
      if (flow) {
        Logger.log(`GraphViewProvider: Flow data found for ID ${flowId}. Posting to webview.`);
        this.postMessageToWebview({ command: "showFlow", payload: flow });
      } else {
        Logger.error(`GraphViewProvider: No flow found for ID ${flowId}.`);
        this.postMessageToWebview({
          command: "showFlow",
          payload: { error: `Flow with ID ${flowId} not found.` },
        });
      }
    } catch (error) {
      Logger.error(`GraphViewProvider: Error fetching flow ID ${flowId}:`, error);
      this.postMessageToWebview({
        command: "showFlow",
        payload: { error: `Error loading flow: ${error}` },
      });
    }
  }

  public async requestExport(format: "svg" | "png" | "markdown"): Promise<any> {
    if (!this._webviewView) {
      vscode.window.showErrorMessage("Graph view is not visible.");
      return null;
    }
    const requestId = uuidv4();
    this.postMessageToWebview({ command: `export-${format}`, payload: { requestId } });

    return new Promise((resolve, reject) => {
      const disposable = this._webviewView?.webview.onDidReceiveMessage(
        (message: WebviewToExtensionMessage) => {
          if (
            message.command === `export-${format}-result` &&
            message.payload.requestId === requestId
          ) {
            disposable?.dispose();
            if (message.payload.error) {
              reject(new Error(message.payload.error));
            } else {
              resolve(message.payload.data);
            }
          }
        }
      );

      // Timeout for the export request
      setTimeout(() => {
        disposable?.dispose();
        reject(new Error(`Export to ${format} timed out.`));
      }, 10000); // 10 seconds timeout
    });
  }

  private postMessageToWebview(message: ExtensionToWebviewMessage) {
    if (this._webviewView) {
      this._webviewView.webview.postMessage(message);
      Logger.log(
        "GraphViewProvider posted message to webview:",
        message.command,
        !!message.payload
      );
    } else {
      Logger.error(
        "GraphViewProvider: Attempted to post message, but webview is not available.",
        message.command
      );
    }
  }

  private _getWebviewContent(webview: vscode.Webview): string {
    //
    const webviewUri = getUri(webview, this._extensionUri, ["out", "webview.js"]); //
    const stylesUri = getUri(webview, this._extensionUri, ["out", "styles.css"]); //
    const mermaidUri = getUri(webview, this._extensionUri, [
      "node_modules",
      "mermaid",
      "dist",
      "mermaid.min.js",
    ]);
    const nonce = getNonce(); //

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="
            default-src 'none';
            style-src ${webview.cspSource} 'unsafe-inline';
            img-src ${webview.cspSource} data:;
            script-src 'nonce-${nonce}';
            font-src ${webview.cspSource};
          ">
          <link rel="stylesheet" type="text/css" href="${stylesUri}">
          <title>Flow Master Graph</title>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `; //
  }
}
function uuidv4() {
  throw new Error("Function not implemented.");
}
