import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Service Worker já é registrado no index.html com auto-reload

createRoot(document.getElementById("root")!).render(<App />);
