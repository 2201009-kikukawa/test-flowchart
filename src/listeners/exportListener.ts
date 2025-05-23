import * as vscode from "vscode";
import { FlowStorageService } from "./flowStorageService";
import { GraphViewProvider } from "../providers/GraphViewProvider";
import { Logger } from "../utilities/logger";
import * as fs from "fs";
import * as path from "path";

async function getFlowIdForExport(
  flowStorageService: FlowStorageService,
  operation: string
): Promise<string | undefined> {
  const flows = await flowStorageService.getAllFlows();
  if (!flows || flows.length === 0) {
    vscode.window.showInformationMessage(`No flows available to export as ${operation}.`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    flows.map((f) => ({ label: f.name, description: f.description, id: f.id })),
    { placeHolder: `Select a flow to export as ${operation}` }
  );
  return picked?.id;
}

async function saveExportedFile(
  content: string,
  defaultFileName: string,
  filters: { [name: string]: string[] }
): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.workspace.workspaceFolders
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultFileName)
      : vscode.Uri.file(defaultFileName),
    filters: filters,
  });

  if (uri) {
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      vscode.window.showInformationMessage(`Flow exported successfully to: ${uri.fsPath}`);
      Logger.log(`File saved to ${uri.fsPath}`);
    } catch (error) {
      Logger.error("Error saving exported file:", error);
      vscode.window.showErrorMessage("Failed to save exported file.");
    }
  }
}

export const exportFlowSVGHandler = async (
  flowIdFromCommandOrEvent: string | undefined | { flow: { id: string } } | vscode.TreeItem,
  flowStorageService: FlowStorageService,
  graphViewProvider: GraphViewProvider
) => {
  let flowIdToExport: string | undefined = undefined;
  if (typeof flowIdFromCommandOrEvent === "string") {
    flowIdToExport = flowIdFromCommandOrEvent;
  } else if (flowIdFromCommandOrEvent && typeof flowIdFromCommandOrEvent === "object") {
    // @ts-ignore
    if (flowIdFromCommandOrEvent.flow && typeof flowIdFromCommandOrEvent.flow.id === "string") {
      // @ts-ignore
      flowIdToExport = flowIdFromCommandOrEvent.flow.id;
    } // @ts-ignore
    else if (typeof flowIdFromCommandOrEvent.id === "string") {
      // @ts-ignore
      flowIdToExport = flowIdFromCommandOrEvent.id;
    }
  }

  if (!flowIdToExport) {
    flowIdToExport = await getFlowIdForExport(flowStorageService, "SVG");
    if (!flowIdToExport) return;
  }

  const flow = await flowStorageService.getFlowById(flowIdToExport);
  if (!flow) {
    vscode.window.showErrorMessage("Selected flow not found.");
    return;
  }

  try {
    // Ensure the view is active to request SVG
    await vscode.commands.executeCommand(`${GraphViewProvider.viewType}.focus`);
    // Ensure the correct flow is loaded in the view
    await graphViewProvider.showFlow(flow.id);

    const svgContent = await graphViewProvider.requestExport("svg");
    if (svgContent) {
      await saveExportedFile(svgContent, `${flow.name.replace(/[^a-z0-9]/gi, "_")}.svg`, {
        "SVG Image": ["svg"],
      });
    } else {
      vscode.window.showErrorMessage("Failed to generate SVG content from webview.");
    }
  } catch (error) {
    Logger.error("Error exporting SVG:", error);
    vscode.window.showErrorMessage(`Failed to export SVG: ${error}`);
  }
};

export const exportFlowPNGHandler = async (
  flowIdFromCommandOrEvent: string | undefined | { flow: { id: string } } | vscode.TreeItem,
  flowStorageService: FlowStorageService,
  graphViewProvider: GraphViewProvider
) => {
  let flowIdToExport: string | undefined = undefined;
  if (typeof flowIdFromCommandOrEvent === "string") {
    flowIdToExport = flowIdFromCommandOrEvent;
  } else if (flowIdFromCommandOrEvent && typeof flowIdFromCommandOrEvent === "object") {
    // @ts-ignore
    if (flowIdFromCommandOrEvent.flow && typeof flowIdFromCommandOrEvent.flow.id === "string") {
      // @ts-ignore
      flowIdToExport = flowIdFromCommandOrEvent.flow.id;
    } // @ts-ignore
    else if (typeof flowIdFromCommandOrEvent.id === "string") {
      // @ts-ignore
      flowIdToExport = flowIdFromCommandOrEvent.id;
    }
  }

  if (!flowIdToExport) {
    flowIdToExport = await getFlowIdForExport(flowStorageService, "PNG");
    if (!flowIdToExport) return;
  }
  const flow = await flowStorageService.getFlowById(flowIdToExport);
  if (!flow) {
    vscode.window.showErrorMessage("Selected flow not found.");
    return;
  }

  try {
    await vscode.commands.executeCommand(`${GraphViewProvider.viewType}.focus`);
    await graphViewProvider.showFlow(flow.id);

    const pngDataUrl = await graphViewProvider.requestExport("png"); // This will be a base64 data URL
    if (
      pngDataUrl &&
      typeof pngDataUrl === "string" &&
      pngDataUrl.startsWith("data:image/png;base64,")
    ) {
      const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.workspace.workspaceFolders
          ? vscode.Uri.joinPath(
              vscode.workspace.workspaceFolders[0].uri,
              `${flow.name.replace(/[^a-z0-9]/gi, "_")}.png`
            )
          : vscode.Uri.file(`${flow.name.replace(/[^a-z0-9]/gi, "_")}.png`),
        filters: { "PNG Image": ["png"] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, buffer);
        vscode.window.showInformationMessage(`Flow exported successfully to: ${uri.fsPath}`);
      }
    } else {
      vscode.window.showErrorMessage("Failed to generate PNG content from webview.");
    }
  } catch (error) {
    Logger.error("Error exporting PNG:", error);
    vscode.window.showErrorMessage(`Failed to export PNG: ${error}`);
  }
};

export const exportFlowMarkdownHandler = async (
  flowIdFromCommandOrEvent: string | undefined | { flow: { id: string } } | vscode.TreeItem,
  flowStorageService: FlowStorageService,
  graphViewProvider: GraphViewProvider
) => {
  let flowIdToExport: string | undefined = undefined;
  if (typeof flowIdFromCommandOrEvent === "string") {
    flowIdToExport = flowIdFromCommandOrEvent;
  } else if (flowIdFromCommandOrEvent && typeof flowIdFromCommandOrEvent === "object") {
    // @ts-ignore
    if (flowIdFromCommandOrEvent.flow && typeof flowIdFromCommandOrEvent.flow.id === "string") {
      // @ts-ignore
      flowIdToExport = flowIdFromCommandOrEvent.flow.id;
    } // @ts-ignore
    else if (typeof flowIdFromCommandOrEvent.id === "string") {
      // @ts-ignore
      flowIdToExport = flowIdFromCommandOrEvent.id;
    }
  }

  if (!flowIdToExport) {
    flowIdToExport = await getFlowIdForExport(flowStorageService, "Markdown");
    if (!flowIdToExport) return;
  }
  const flow = await flowStorageService.getFlowById(flowIdToExport);
  if (!flow) {
    vscode.window.showErrorMessage("Selected flow not found.");
    return;
  }

  try {
    // Markdown export might not need the webview if we can regenerate mermaid syntax
    // However, for consistency or if webview does special processing:
    await vscode.commands.executeCommand(`${GraphViewProvider.viewType}.focus`);
    await graphViewProvider.showFlow(flow.id);

    const markdownContent = await graphViewProvider.requestExport("markdown");
    if (markdownContent) {
      let fullMarkdown = `# ${flow.name}\n\n`;
      fullMarkdown += `**Category:** ${flow.category || "N/A"}  \n`;
      fullMarkdown += `**Description:** ${flow.description || "No description."}  \n`;
      if (flow.tags && flow.tags.length > 0) {
        fullMarkdown += `**Tags:** ${flow.tags.join(", ")}  \n`;
      }
      fullMarkdown += `\n## Flow Diagram (Mermaid)\n\n`;
      fullMarkdown += markdownContent; // This should be the ```mermaid\n...\n``` block

      await saveExportedFile(fullMarkdown, `${flow.name.replace(/[^a-z0-9]/gi, "_")}.md`, {
        Markdown: ["md"],
      });
    } else {
      vscode.window.showErrorMessage("Failed to generate Markdown content from webview.");
    }
  } catch (error) {
    Logger.error("Error exporting Markdown:", error);
    vscode.window.showErrorMessage(`Failed to export Markdown: ${error}`);
  }
};
