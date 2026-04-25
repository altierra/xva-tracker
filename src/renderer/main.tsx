import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Catch unhandled promise rejections so they log instead of crashing the renderer
window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer] Unhandled rejection:", event.reason);
  event.preventDefault(); // prevent the default crash behavior
});

window.addEventListener("error", (event) => {
  console.error("[renderer] Uncaught error:", event.error);
});

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
