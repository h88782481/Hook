import { render } from "solid-js/web";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./app";
import { SettingsPage } from "./components/SettingsPage";
import { isTauriRuntimeAvailable } from "./services/api";
import "./app.css";

const mount = async () => {
  const root = document.getElementById("app");
  if (!root) return;

  let label = "main";
  if (isTauriRuntimeAvailable()) {
    try {
      label = getCurrentWindow().label;
    } catch {
      label = "main";
    }
  }

  if (label === "settings") {
    render(() => <SettingsPage />, root);
    return;
  }

  render(() => <App />, root);
};

void mount();
