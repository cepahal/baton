import { HANDOFF_ID_PATTERN } from "@baton/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { useMe } from "./hooks/useMe.js";
import { HandoffPage } from "./pages/HandoffPage.js";
import { PairPage } from "./pages/PairPage.js";
import "@xyflow/react/dist/style.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

/** The viewer is one page; `/handoffs/:id` and `/pair` are standalone pages next to it. */
function Root() {
  const { me, refresh } = useMe();
  const path = window.location.pathname;
  if (path === "/pair") return <PairPage onPaired={refresh} />;
  const handoff = /^\/handoffs\/([^/]+)\/?$/.exec(path)?.[1];
  if (handoff !== undefined && HANDOFF_ID_PATTERN.test(handoff)) {
    return <HandoffPage id={handoff} me={me} />;
  }
  return <App me={me} />;
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
