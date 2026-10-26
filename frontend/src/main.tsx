import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Account } from "./Account";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import "./EvidenceCard.css";

createRoot(document.getElementById("root")!).render(
  <Account>
    <App />
  </Account>,
);
