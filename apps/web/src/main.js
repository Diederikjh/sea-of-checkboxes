import "./style.css";
import { bootstrapFrontend } from "./frontendBootstrap";

void bootstrapFrontend().catch((error) => {
  console.error(
    "frontend_bootstrap_failed",
    error instanceof Error ? error.message : String(error)
  );
});
