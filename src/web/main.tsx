import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("The browser shell needs a root element.");
}

createRoot(root).render(<App />);
