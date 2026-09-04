import { spawn } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "start" ? "start" : "dev";
const webHost = process.env.WEB_HOST || "127.0.0.1";
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}`,
  NEXT_PUBLIC_ACCOUNT_API_ORIGIN: process.env.NEXT_PUBLIC_ACCOUNT_API_ORIGIN ?? (mode === "dev" ? "http://127.0.0.1:3210" : ""),
};
const web = spawn(resolve(projectRoot, "node_modules", ".bin", "vinext"), [mode, "--port", "3000", "--hostname", webHost], { cwd: projectRoot, env, stdio: "inherit" });
const companion = spawn(process.execPath, [resolve(projectRoot, "local", "server.mjs")], { cwd: projectRoot, env, stdio: "inherit" });
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; web.kill("SIGTERM"); companion.kill("SIGTERM"); setTimeout(() => process.exit(code), 300).unref(); }
web.on("exit", (code) => stop(code || 0));
companion.on("exit", (code) => stop(code || 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
