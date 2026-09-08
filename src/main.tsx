import "./styles.css";
import { App } from "@/components/AppRoot";

const rootElement = document.getElementById("root")!;
import("react-dom/client").then(({ createRoot }) => {
  createRoot(rootElement).render(<App />);
});
