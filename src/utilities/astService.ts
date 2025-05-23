import * as vscode from "vscode";
import * as path from "path";
import {
  Project,
  Node,
  FunctionDeclaration,
  MethodDeclaration,
  ArrowFunction,
  SourceFile,
} from "ts-morph";
import { FlowNode, FlowEdge, CodeReference } from "../types/flowTypes";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "./logger";

export class AstService {
  private project: Project;

  constructor() {
    this.project = new Project({
      // Optionally configure compiler options if needed, or it will use tsconfig.json
      // useInMemoryFileSystem: true, // Can be useful if you don't want to write to disk
    });
  }

  private createCodeReference(node: Node): CodeReference {
    const sourceFile = node.getSourceFile();
    const startPos = node.getStart();
    const endPos = node.getEnd();
    const start = sourceFile.getLineAndColumnAtPos(startPos);
    const end = sourceFile.getLineAndColumnAtPos(endPos);
    return {
      filePath: sourceFile.getFilePath(),
      range: {
        start: { line: start.line - 1, character: start.column - 1 }, // 0-indexed
        end: { line: end.line - 1, character: end.column - 1 },
      },
      identifier: Node.isIdentifier(node) ? node.getText() : undefined,
    };
  }

  public async parseFunctionCalls(
    filePath: string,
    functionName?: string, // If parsing a specific function
    startLine?: number, // For range-based parsing
    endLine?: number
  ): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> {
    Logger.log(
      `AST Service: Parsing ${filePath}, function: ${functionName}, range: ${startLine}-${endLine}`
    );
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let sourceFile: SourceFile;

    try {
      // Check if file already exists in project to avoid re-adding
      const existingSourceFile = this.project.getSourceFile(filePath);
      if (existingSourceFile) {
        // Refresh from disk to ensure it's up-to-date
        await existingSourceFile.refreshFromFileSystem();
        sourceFile = existingSourceFile;
      } else {
        sourceFile = this.project.addSourceFileAtPath(filePath);
      }
      await sourceFile.refreshFromFileSystem(); // Ensure content is fresh
    } catch (error) {
      Logger.error(`AST Service: Error adding or refreshing source file ${filePath}`, error);
      vscode.window.showErrorMessage(
        `Flow Master: Could not parse file ${filePath}. Ensure it's a valid TypeScript/JavaScript file.`
      );
      return { nodes: [], edges: [] };
    }

    let entryNodeId: string | null = null;
    let rootNodeToScan: Node | undefined = sourceFile;

    if (functionName) {
      const foundFunction = this.findFunctionByName(sourceFile, functionName, startLine);
      if (foundFunction) {
        rootNodeToScan = foundFunction;
        const funcNodeId = uuidv4();
        entryNodeId = funcNodeId;
        nodes.push({
          id: funcNodeId,
          label: functionName || "Selected Function",
          type: "EntryPoint",
          codeReference: this.createCodeReference(foundFunction),
          description: `Entry point: ${functionName}`,
        });
      } else {
        Logger.error(
          `AST Service: Function ${functionName} not found in ${filePath}. Parsing whole file or specified range.`
        );
      }
    } else if (startLine !== undefined && endLine !== undefined) {
      // For arbitrary range, create a conceptual entry point.
      // The actual parsing of calls will happen on all nodes within this range.
      const rangeNodeId = uuidv4();
      entryNodeId = rangeNodeId;
      // Find the top-most encompassing node for the range or just use sourceFile.
      // This is a simplification; more precise range analysis would be complex.
      nodes.push({
        id: rangeNodeId,
        label: `Code Block (Lines ${startLine}-${endLine})`,
        type: "EntryPoint",
        description: `Selected code block in ${path.basename(filePath)}`,
        // No direct codeReference for the block itself unless we find an encompassing node.
      });
      // Limit scanning to nodes within the range (approximate)
      // This requires iterating descendants and checking line numbers.
    } else {
      const fileNodeId = uuidv4();
      entryNodeId = fileNodeId;
      nodes.push({
        id: fileNodeId,
        label: path.basename(filePath),
        type: "EntryPoint",
        description: `Entry: File ${path.basename(filePath)}`,
        codeReference: this.createCodeReference(
          sourceFile.getFullText().length > 0 ? sourceFile.getChildSyntaxListOrThrow() : sourceFile
        ),
      });
    }

    if (!entryNodeId) {
      Logger.error("AST Service: Could not determine an entry point for parsing.");
      return { nodes, edges };
    }

    let lastProcessedNodeId = entryNodeId;

    rootNodeToScan.forEachDescendant((node, traversal) => {
      // If range is specified, skip nodes outside the range
      if (startLine !== undefined && endLine !== undefined) {
        const nodeStartLine = node.getStartLineNumber();
        const nodeEndLine = node.getEndLineNumber();
        if (nodeStartLine < startLine || nodeEndLine > endLine) {
          // If node is completely outside, skip its children too
          if (nodeEndLine < startLine || nodeStartLine > endLine) {
            traversal.skip();
          }
          return; // Continue to next descendant if partially overlapping or just skip
        }
      }

      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        let callName = callee.getText(); // Simplified; could be obj.method, etc.

        if (Node.isIdentifier(callee)) {
          callName = callee.getText();
        } else if (Node.isPropertyAccessExpression(callee)) {
          callName = `${callee.getExpression().getText()}.${callee.getName()}`;
        }

        const existingNode = nodes.find(
          (n) =>
            n.label === callName &&
            JSON.stringify(n.codeReference) === JSON.stringify(this.createCodeReference(callee))
        );
        let callNodeId: string;

        if (existingNode) {
          callNodeId = existingNode.id;
        } else {
          callNodeId = uuidv4();
          nodes.push({
            id: callNodeId,
            label: callName,
            type: "Function",
            codeReference: this.createCodeReference(callee),
            description: `Call to ${callName}`,
          });
        }

        // Create an edge from the last processed node (function or previous call)
        // This is a sequential flow assumption, needs refinement for control flow.
        if (lastProcessedNodeId && lastProcessedNodeId !== callNodeId) {
          const edgeId = uuidv4();
          edges.push({
            id: edgeId,
            from: lastProcessedNodeId,
            to: callNodeId,
            type: "DirectCall",
          });
        }
        lastProcessedNodeId = callNodeId; // Update for next call in sequence

        // Future: Recursively parse called functions if they are in the project
        // For now, just list the call.
      }
      // TODO: Add handlers for IfStatement, ForStatement, WhileStatement, SwitchStatement etc.
      // to represent control flow. This would involve creating Condition nodes and multiple edges.
    });
    Logger.log(`AST Service: Parsing complete. Nodes: ${nodes.length}, Edges: ${edges.length}`);
    return { nodes, edges };
  }

  private findFunctionByName(
    sourceFile: SourceFile,
    functionName: string,
    targetLine?: number
  ): FunctionDeclaration | MethodDeclaration | ArrowFunction | undefined {
    const functions = sourceFile.getFunctions();
    let foundFunc: FunctionDeclaration | MethodDeclaration | ArrowFunction | undefined;

    foundFunc = functions.find(
      (f) =>
        f.getName() === functionName &&
        (targetLine === undefined || this.isNodeAroundLine(f, targetLine))
    );
    if (foundFunc) return foundFunc;

    sourceFile.getClasses().forEach((c) => {
      if (foundFunc) return;
      foundFunc = c
        .getMethods()
        .find(
          (m) =>
            m.getName() === functionName &&
            (targetLine === undefined || this.isNodeAroundLine(m, targetLine))
        );
      if (foundFunc) return;
      // Check for arrow function properties
      c.getProperties().forEach((p) => {
        if (foundFunc) return;
        const initializer = p.getInitializer();
        if (
          initializer &&
          Node.isArrowFunction(initializer) &&
          p.getName() === functionName &&
          (targetLine === undefined || this.isNodeAroundLine(p, targetLine))
        ) {
          foundFunc = initializer;
        }
      });
    });
    if (foundFunc) return foundFunc;

    // Check top-level variable declarations for arrow functions
    sourceFile.getVariableDeclarations().forEach((vd) => {
      if (foundFunc) return;
      const initializer = vd.getInitializer();
      if (
        Node.isArrowFunction(initializer) &&
        vd.getName() === functionName &&
        (targetLine === undefined || this.isNodeAroundLine(vd, targetLine))
      ) {
        foundFunc = initializer;
      }
    });

    return foundFunc;
  }

  private isNodeAroundLine(node: Node, targetLine: number): boolean {
    const startLine = node.getStartLineNumber();
    const endLine = node.getEndLineNumber();
    return targetLine >= startLine && targetLine <= endLine;
  }

  public async getFunctionNameAtCursor(
    filePath: string,
    position: vscode.Position
  ): Promise<string | undefined> {
    let sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) {
      sourceFile = this.project.addSourceFileAtPath(filePath);
    }
    await sourceFile.refreshFromFileSystem();

    const posInFile = sourceFile.compilerNode.getPositionOfLineAndCharacter(
      position.line,
      position.character
    );

    let containingFunction: Node | undefined;
    sourceFile.forEachDescendant((node) => {
      if (node.getStart() <= posInFile && posInFile < node.getEnd()) {
        if (
          Node.isFunctionDeclaration(node) ||
          Node.isMethodDeclaration(node) ||
          Node.isArrowFunction(node) ||
          Node.isFunctionExpression(node)
        ) {
          // Check if this is the smallest (most deeply nested) function containing the position
          if (
            !containingFunction ||
            (node.getStart() >= containingFunction.getStart() &&
              node.getEnd() <= containingFunction.getEnd())
          ) {
            containingFunction = node;
          }
        }
      }
    });

    if (containingFunction) {
      if (
        Node.isFunctionDeclaration(containingFunction) ||
        Node.isMethodDeclaration(containingFunction)
      ) {
        return containingFunction.getName();
      } else if (
        Node.isArrowFunction(containingFunction) ||
        Node.isFunctionExpression(containingFunction)
      ) {
        // Try to get name from variable declaration if it's assigned
        const parent = containingFunction.getParent();
        if (Node.isVariableDeclaration(parent)) {
          return parent.getName();
        }
        if (Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent)) {
          return parent.getName();
        }
      }
    }
    return undefined;
  }
}
