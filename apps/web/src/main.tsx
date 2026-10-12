import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initializeTheme } from "./lib/theme";
import "./styles.css";

initializeTheme();
const root = document.getElementById("root");
if (!root) throw new Error("Website root is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
