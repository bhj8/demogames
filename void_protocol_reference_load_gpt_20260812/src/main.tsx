import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import VoidProtocolGame from "./VoidProtocolGame";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VoidProtocolGame />
  </StrictMode>,
);
