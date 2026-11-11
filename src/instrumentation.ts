/**
 * Runs once when the server starts: fail fast if core configuration is
 * missing. Only variable names are reported.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { parseEnv, publicSchema, serverSchemas } = await import("./env");
  parseEnv(publicSchema, process.env);
  parseEnv(serverSchemas.core, process.env);
}
