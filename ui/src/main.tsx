import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// shadcn's tokens key off a `.dark` class, and this is the whole theme system:
// follow the OS and stop. A toggle would mean persistence, a third state
// ("system"), and a preference nobody asked a terminal-first audience for.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const apply = () => document.documentElement.classList.toggle("dark", dark.matches);
dark.addEventListener("change", apply);
apply();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
