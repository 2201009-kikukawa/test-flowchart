import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react";

const main = () => {
  const [text, setText] = useState<string>("");

  return (
    <>
      <VSCodeButton onClick={(e) => setText("ボタンがクリックされました")}>ボタン</VSCodeButton>
      <div>{text}</div>
    </>
  );
};

export default main;

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(React.createElement(main));
