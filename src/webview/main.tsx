import React, { useState, useEffect, useCallback, useMemo } from "react";
import ReactDOM from "react-dom/client";
import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodeTextField,
  VSCodeDropdown,
  VSCodeOption,
  VSCodeTag,
  VSCodeProgressRing,
} from "@vscode/webview-ui-toolkit/react";
import {
  CapturedFlow,
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
  FlowNode,
  FlowEdge,
  CodeReference,
} from "../types/flowTypes";
import mermaid from "mermaid"; //
// @ts-ignore
const vscode = acquireVsCodeApi(); // Standard way to get VS Code API in webview

mermaid.initialize({
  startOnLoad: false, // We will render manually
  theme: "base", // Or 'dark', 'forest', 'neutral' - can be dynamic based on VS Code theme
  securityLevel: "loose", // Or 'strict' if CSP allows, 'sandbox'
  flowchart: {
    htmlLabels: true,
    useMaxWidth: true,
  },
  // logLeve: 'debug' // For debugging mermaid
});

const generateMermaidDiagram = (flow: CapturedFlow | null): string => {
  if (!flow || !flow.nodes || flow.nodes.length === 0) {
    return "graph TD\n  A[No flow data to display. Select a flow from the sidebar or capture a new one.]";
  }

  let diagram = "graph TD\n"; // Top-Down graph

  // Add node definitions
  flow.nodes.forEach((node) => {
    // Sanitize label for Mermaid: replace special characters, escape quotes
    const sanitizedLabel = node.label.replace(/[#;"()]/g, "_").replace(/`/g, "'");
    let nodeShapeStart = "[";
    let nodeShapeEnd = "]";
    switch (node.type) {
      case "EntryPoint":
      case "ExitPoint":
        nodeShapeStart = "((";
        nodeShapeEnd = "))";
        break;
      case "Condition":
        nodeShapeStart = "{";
        nodeShapeEnd = "}";
        break;
      case "ManualStep":
      case "Note":
        nodeShapeStart = "[/";
        nodeShapeEnd = "/]";
        break;
    }
    // Add class for styling and click handling
    diagram += `  ${node.id}${nodeShapeStart}"${sanitizedLabel}"${nodeShapeEnd};\n`;
    if (node.codeReference) {
      // Add click handler via Mermaid's API (or attach event listeners later)
      diagram += `  click ${node.id} call handleNodeClick("${node.id}") "Go to code for ${sanitizedLabel}"\n`;
    }
  });

  // Add edge definitions
  flow.edges.forEach((edge) => {
    const edgeLabel = edge.label ? `|"${edge.label.replace(/[#;"()]/g, "_")}"|` : "";
    diagram += `  ${edge.from} -->${edgeLabel} ${edge.to};\n`;
  });

  // Styling (optional, can be done via CSS too if mermaid supports classes well)
  // flow.nodes.forEach(node => {
  //   if (node.type === 'EntryPoint') diagram += `  style ${node.id} fill:#f9f,stroke:#333,stroke-width:2px\n`;
  // });

  return diagram;
};

const FlowGraphApp: React.FC = () => {
  const [currentFlow, setCurrentFlow] = useState<CapturedFlow | null>(null);
  const [mermaidDiagram, setMermaidDiagram] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // For metadata editing
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCategory, setEditCategory] = useState<CapturedFlow["category"]>("General");

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (currentFlow) {
        const node = currentFlow.nodes.find((n) => n.id === nodeId);
        if (node && node.codeReference) {
          vscode.postMessage({
            command: "jumpToCode",
            payload: {
              filePath: node.codeReference.filePath,
              range: node.codeReference.range,
            },
          } as WebviewToExtensionMessage);
        }
      }
    },
    [currentFlow]
  );

  // Make handleNodeClick globally available for Mermaid
  useEffect(() => {
    // @ts-ignore
    window.handleNodeClick = handleNodeClick;
    return () => {
      // @ts-ignore
      delete window.handleNodeClick;
    };
  }, [handleNodeClick]);

  useEffect(() => {
    const messageHandler = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;
      switch (message.command) {
        case "showFlow":
          setIsLoading(false);
          if (message.payload) {
            const flowData = message.payload as CapturedFlow;
            setCurrentFlow(flowData);
            setEditName(flowData.name);
            setEditDescription(flowData.description);
            setEditCategory(flowData.category || "General");
            setError(null);
          } else {
            setCurrentFlow(null);
            setError(message.payload?.error || "No flow selected or an error occurred.");
          }
          break;
        case "export-svg":
        case "export-png":
        case "export-markdown":
          if (currentFlow) {
            const graphDiv = document.getElementById("mermaid-graph");
            if (
              graphDiv &&
              graphDiv.firstElementChild &&
              graphDiv.firstElementChild.tagName === "svg"
            ) {
              const svgElement = graphDiv.firstElementChild as SVGSVGElement;
              const svgData = new XMLSerializer().serializeToString(svgElement);

              if (message.command === "export-svg") {
                vscode.postMessage({
                  command: `${message.command}-result`,
                  payload: { requestId: message.payload.requestId, data: svgData },
                });
              } else if (message.command === "export-png") {
                // Basic SVG to PNG using canvas (client-side, might have limitations)
                const img = new Image();
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
                const url = URL.createObjectURL(svgBlob);

                img.onload = () => {
                  canvas.width = img.width;
                  canvas.height = img.height;
                  ctx?.drawImage(img, 0, 0);
                  const pngDataUrl = canvas.toDataURL("image/png");
                  vscode.postMessage({
                    command: `${message.command}-result`,
                    payload: { requestId: message.payload.requestId, data: pngDataUrl },
                  });
                  URL.revokeObjectURL(url);
                };
                img.onerror = (e) => {
                  vscode.postMessage({
                    command: `${message.command}-result`,
                    payload: {
                      requestId: message.payload.requestId,
                      error: "Failed to load SVG for PNG conversion.",
                    },
                  });
                  URL.revokeObjectURL(url);
                };
                img.src = url;
              } else if (message.command === "export-markdown") {
                const md = `\`\`\`mermaid\n${generateMermaidDiagram(currentFlow)}\n\`\`\``;
                vscode.postMessage({
                  command: `${message.command}-result`,
                  payload: { requestId: message.payload.requestId, data: md },
                });
              }
            } else {
              vscode.postMessage({
                command: `${message.command}-result`,
                payload: {
                  requestId: message.payload.requestId,
                  error: "SVG graph not found for export.",
                },
              });
            }
          } else {
            vscode.postMessage({
              command: `${message.command}-result`,
              payload: { requestId: message.payload.requestId, error: "No flow data to export." },
            });
          }
          break;
      }
    };

    window.addEventListener("message", messageHandler);

    // Notify extension that webview is ready
    vscode.postMessage({ command: "webviewReady" } as WebviewToExtensionMessage);

    return () => {
      window.removeEventListener("message", messageHandler);
    };
  }, [currentFlow]); // Add currentFlow to dependencies if messageHandler uses it directly for export

  useEffect(() => {
    if (currentFlow) {
      const diag = generateMermaidDiagram(currentFlow);
      setMermaidDiagram(diag);
      // console.log("Generated Mermaid Diagram:", diag);
    } else {
      setMermaidDiagram(generateMermaidDiagram(null)); // Show default message
    }
  }, [currentFlow]);

  useEffect(() => {
    if (mermaidDiagram) {
      const graphDiv = document.getElementById("mermaid-graph");
      if (graphDiv) {
        try {
          // Render the diagram
          mermaid
            .render("mermaid-svg-graph", mermaidDiagram)
            .then(({ svg, bindFunctions }) => {
              graphDiv.innerHTML = svg;
              if (bindFunctions) {
                bindFunctions(graphDiv); // This is crucial for `click` handlers
              }
            })
            .catch((renderError) => {
              console.error("Mermaid render error:", renderError);
              setError(
                `Mermaid render error: ${
                  renderError.message || renderError
                }. Diagram:\n${mermaidDiagram}`
              );
              graphDiv.innerHTML = `<pre>Error rendering graph. Check console. Diagram:\n${mermaidDiagram.substring(
                0,
                500
              )}...</pre>`;
            });
        } catch (e: any) {
          console.error("Error rendering Mermaid diagram:", e);
          setError(`Error rendering diagram: ${e.message}. Diagram:\n${mermaidDiagram}`);
          graphDiv.innerHTML = `<pre>Error rendering graph. Diagram:\n${mermaidDiagram.substring(
            0,
            500
          )}...</pre>`;
        }
      }
    }
  }, [mermaidDiagram]);

  const handleSaveMetadata = () => {
    if (currentFlow) {
      const updatedFlow: CapturedFlow = {
        ...currentFlow,
        name: editName,
        description: editDescription,
        category: editCategory,
      };
      vscode.postMessage({
        command: "updateFlowMetadata",
        payload: { flow: updatedFlow },
      } as WebviewToExtensionMessage);
    }
  };

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
        }}>
        <VSCodeProgressRing /> Loading Flow...
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "1rem",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        boxSizing: "border-box",
      }}>
      {error && (
        <div style={{ color: "red", marginBottom: "1rem", whiteSpace: "pre-wrap" }}>
          Error: {error}
        </div>
      )}
      {currentFlow && (
        <div
          style={{
            marginBottom: "1rem",
            border: "1px solid var(--vscode-editorWidget-border)",
            padding: "0.5rem",
          }}>
          <h3>Edit Metadata for: {currentFlow.name}</h3>
          <VSCodeTextField
            value={editName}
            onInput={(e: any) => setEditName(e.target.value)}
            style={{ marginBottom: "0.5rem", width: "100%" }}>
            Name
          </VSCodeTextField>
          <VSCodeTextArea
            value={editDescription}
            onInput={(e: any) => setEditDescription(e.target.value)}
            resize="vertical"
            style={{ marginBottom: "0.5rem", width: "100%" }}>
            Description
          </VSCodeTextArea>
          <VSCodeDropdown
            value={editCategory}
            onInput={(e: any) => setEditCategory(e.target.value)}
            style={{ marginBottom: "0.5rem", width: "100%" }}>
            <VSCodeOption value="General">General</VSCodeOption>
            <VSCodeOption value="User Interaction">User Interaction</VSCodeOption>
            <VSCodeOption value="Data Processing">Data Processing</VSCodeOption>
            <VSCodeOption value="API Call">API Call</VSCodeOption>
            <VSCodeOption value="Authentication">Authentication</VSCodeOption>
            <VSCodeOption value="Needs Review">Needs Review</VSCodeOption>
          </VSCodeDropdown>
          <VSCodeButton onClick={handleSaveMetadata}>Save Metadata</VSCodeButton>
        </div>
      )}
      <div
        id="mermaid-graph-container"
        style={{
          flexGrow: 1,
          overflow: "auto",
          border: "1px solid var(--vscode-divider-background)",
        }}>
        <div id="mermaid-graph" style={{ width: "100%", height: "100%" }}>
          {/* Mermaid SVG will be injected here */}
        </div>
      </div>
    </div>
  );
};

const rootElement = document.getElementById("root");
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<FlowGraphApp />);
} else {
  console.error("Fatal: Root element not found for React app.");
}
