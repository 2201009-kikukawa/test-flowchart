import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ProjectFlows, CapturedFlow } from "../types/flowTypes";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "../utilities/logger";
import { FlowListProvider } from "../providers/FlowListProvider";

const DEFAULT_FLOW_FILE_VERSION = "1.0";

export class FlowStorageService {
  private context: vscode.ExtensionContext;
  private flowsFilePath: string;
  private flowsFileWatcher: vscode.FileSystemWatcher | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.flowsFilePath = this.getFlowsFilePath();
    this.ensureFlowsFileExists();
  }

  private getFlowsFilePath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage(
        "Flow Master: No workspace open. Please open a folder to use Flow Master."
      );
      Logger.error("No workspace folder open.");
      throw new Error("No workspace folder open.");
    }
    // Allow users to configure the path
    const configuredPath = vscode.workspace
      .getConfiguration("flowMaster")
      .get<string>("sharedFlowsFile");
    if (!configuredPath) {
      Logger.error("Flow Master: 'sharedFlowsFile' configuration is missing.");
      vscode.window.showErrorMessage("Flow Master configuration 'sharedFlowsFile' is missing.");
      return path.join(workspaceFolders[0].uri.fsPath, ".flowmaster", "flows.json"); // Fallback
    }
    return path.join(workspaceFolders[0].uri.fsPath, configuredPath);
  }

  public updateFlowsFilePath(): void {
    this.flowsFilePath = this.getFlowsFilePath();
    this.ensureFlowsFileExists();
    Logger.log(`Flows file path updated to: ${this.flowsFilePath}`);
    // Re-initialize watcher if necessary
    this.flowsFileWatcher?.dispose();
    // The watcher is re-created by the extension activate function or a dedicated method if needed
  }

  private async ensureFlowsFileExists(): Promise<void> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(this.flowsFilePath));
    } catch {
      Logger.log(`Flows file not found at ${this.flowsFilePath}. Creating new one.`);
      const initialProjectFlows: ProjectFlows = { version: DEFAULT_FLOW_FILE_VERSION, flows: [] };
      const dirPath = path.dirname(this.flowsFilePath);
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
      } catch (dirError: any) {
        // Ignore if directory already exists
        if (dirError.code !== "EEXIST" && dirError.name !== "EntryExists") {
          Logger.error(`Error creating directory ${dirPath}:`, dirError);
        }
      }
      await this.writeFlowsToFile(initialProjectFlows);
    }
  }

  private async readFlowsFromFile(): Promise<ProjectFlows> {
    try {
      await this.ensureFlowsFileExists(); // Ensure it exists before reading
      const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(this.flowsFilePath));
      const data = JSON.parse(Buffer.from(fileContent).toString("utf8"));
      if (!data.version || !Array.isArray(data.flows)) {
        Logger.error("Invalid flow file structure. Reinitializing.", data);
        return { version: DEFAULT_FLOW_FILE_VERSION, flows: [] };
      }
      return data;
    } catch (error) {
      Logger.error("Error reading flows.json:", error);
      vscode.window.showErrorMessage(
        `Flow Master: Error reading flows file. Check logs. It might be corrupted. Creating a new one if necessary.`
      );
      return { version: DEFAULT_FLOW_FILE_VERSION, flows: [] }; // Return empty/default if error
    }
  }

  private async writeFlowsToFile(projectFlows: ProjectFlows): Promise<void> {
    try {
      const Ggg = JSON.stringify(projectFlows, null, 2);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(this.flowsFilePath),
        Buffer.from(Ggg, "utf8")
      );
    } catch (error) {
      Logger.error("Error writing to flows.json:", error);
      vscode.window.showErrorMessage("Flow Master: Error writing to flows file. Check logs.");
    }
  }

  public async getAllFlows(): Promise<CapturedFlow[]> {
    const projectFlows = await this.readFlowsFromFile();
    return projectFlows.flows;
  }

  public async getFlowById(flowId: string): Promise<CapturedFlow | undefined> {
    const projectFlows = await this.readFlowsFromFile();
    return projectFlows.flows.find((flow) => flow.id === flowId);
  }

  public async saveFlow(
    flow: Omit<CapturedFlow, "id" | "createdAt" | "updatedAt">
  ): Promise<CapturedFlow> {
    const projectFlows = await this.readFlowsFromFile();
    const now = new Date().toISOString();
    const newFlow: CapturedFlow = {
      ...flow,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };
    projectFlows.flows.push(newFlow);
    await this.writeFlowsToFile(projectFlows);
    Logger.log(`Flow saved: ${newFlow.name} (ID: ${newFlow.id})`);
    return newFlow;
  }

  public async updateFlow(updatedFlow: CapturedFlow): Promise<CapturedFlow | undefined> {
    const projectFlows = await this.readFlowsFromFile();
    const index = projectFlows.flows.findIndex((f) => f.id === updatedFlow.id);
    if (index === -1) {
      Logger.error(`Flow with ID ${updatedFlow.id} not found for update.`);
      return undefined;
    }
    projectFlows.flows[index] = {
      ...updatedFlow,
      updatedAt: new Date().toISOString(),
    };
    await this.writeFlowsToFile(projectFlows);
    Logger.log(`Flow updated: ${updatedFlow.name} (ID: ${updatedFlow.id})`);
    return projectFlows.flows[index];
  }

  public async deleteFlow(flowId: string): Promise<boolean> {
    const projectFlows = await this.readFlowsFromFile();
    const initialLength = projectFlows.flows.length;
    projectFlows.flows = projectFlows.flows.filter((f) => f.id !== flowId);
    if (projectFlows.flows.length < initialLength) {
      await this.writeFlowsToFile(projectFlows);
      Logger.log(`Flow deleted (ID: ${flowId})`);
      return true;
    }
    Logger.error(`Attempted to delete non-existent flow (ID: ${flowId})`);
    return false;
  }

  public createFlowsFileWatcher(flowListProvider: FlowListProvider): void {
    if (this.flowsFileWatcher) {
      this.flowsFileWatcher.dispose();
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      // We need to watch the relative path from the workspace root
      const relativePattern = path.relative(workspaceFolders[0].uri.fsPath, this.flowsFilePath);
      this.flowsFileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolders[0], relativePattern)
      );

      const refresh = () => {
        Logger.log(
          `Flows file watcher detected change in ${this.flowsFilePath}. Refreshing flow list.`
        );
        flowListProvider.refresh();
        // Optionally, notify GraphViewProvider if a displayed flow is affected
      };

      this.flowsFileWatcher.onDidChange(refresh);
      this.flowsFileWatcher.onDidCreate(refresh);
      this.flowsFileWatcher.onDidDelete(refresh); // Or handle deletion appropriately

      this.context.subscriptions.push(this.flowsFileWatcher);
      Logger.log(`Watching for changes in: ${this.flowsFilePath}`);
    } else {
      Logger.error("Cannot create file watcher: No workspace folder open.");
    }
  }
}
