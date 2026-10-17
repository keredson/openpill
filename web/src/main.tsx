import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import FlashPage from "./FlashPage";
import { useRoute } from "./navigation";
import "./styles.css";

registerSW({ immediate: true });

function Root() {
  const route = useRoute();
  return route === "/flash" || route === "/restore" ? <FlashPage view={route === "/restore" ? "restore" : "convert"} /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
