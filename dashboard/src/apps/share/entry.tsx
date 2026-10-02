import { StrictMode } from "react";
import { Toaster } from "sonner";
import { createRoot } from "react-dom/client";

import { SharePage } from "./page";
import "../../styles/base.css";
import "../../styles/share.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Share root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <SharePage />
    <Toaster
      position="top-right"
      offset={{ top: "1rem", right: "1rem" }}
      mobileOffset={{ top: "1rem", left: "1rem", right: "1rem" }}
      visibleToasts={2}
      richColors
      toastOptions={{ className: "toast-surface select-text" }}
    />
  </StrictMode>,
);
