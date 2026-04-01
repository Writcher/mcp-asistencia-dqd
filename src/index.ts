import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as dotenv from "dotenv";
import * as http from "http";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  registrarCliente,
  generarUrlAzure,
  manejarCallback,
  generarAuthCode,
  canjearAuthCode,
  generarToken,
  verificarToken,
} from "./auth.js";
import { obtenerModulosUsuario } from "./permisos.js";
import { registrarModuloAsistencia, type AsistenciaConfig } from "./modules/asistencia.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// --- Config ------------------------------------------------------------------

const config = JSON.parse(
  readFileSync(resolve(__dirname, "..", "config.json"), "utf-8")
);

const asistenciaConfig: AsistenciaConfig = {
  proyectos: config.proyectos,
  schema_description: config.schema_description,
};

// --- Helpers -----------------------------------------------------------------

function leerBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// --- HTTP Server -------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const method = req.method ?? "GET";

  console.log(`[HTTP] ${method} ${url.pathname} (auth: ${req.headers["authorization"] ? "present" : "none"})`);

  // 1. Protected Resource Metadata
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return json(res, 200, {
      resource: `${process.env.BASE_URL}/${process.env.PATH_URL}`,
      authorization_servers: [process.env.BASE_URL],
      bearer_methods_supported: ["header"],
    });
  }

  // 2. Authorization Server Metadata
  if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
    return json(res, 200, {
      issuer: process.env.BASE_URL,
      authorization_endpoint: `${process.env.BASE_URL}/oauth/authorize`,
      token_endpoint: `${process.env.BASE_URL}/oauth/token`,
      registration_endpoint: `${process.env.BASE_URL}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
    });
  }

  // 3. Dynamic Client Registration
  if (
    (url.pathname === "/oauth/register" || url.pathname === "/register") &&
    method === "POST"
  ) {
    const raw = await leerBody(req);
    const body = JSON.parse(raw);
    const client = registrarCliente(body);
    console.log(`[DCR] Cliente registrado: ${client.client_id}`);
    return json(res, 201, client);
  }

  // 4. Authorize
  if (
    (url.pathname === "/oauth/authorize" || url.pathname === "/authorize") &&
    method === "GET"
  ) {
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const clientState = url.searchParams.get("state") ?? "";
    const clientCodeChallenge = url.searchParams.get("code_challenge") ?? "";
    const { location } = await generarUrlAzure(redirectUri, clientState, clientCodeChallenge);
    res.writeHead(302, { Location: location });
    return res.end();
  }

  // 5. Callback de Azure
  if (url.pathname === "/oauth/callback" && method === "GET") {
    const code = url.searchParams.get("code") ?? "";
    const azureState = url.searchParams.get("state") ?? "";

    const result = await manejarCallback(code, azureState);
    if (!result) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Error de autenticación. Intentá de nuevo.");
    }

    const authCode = generarAuthCode(result.email, result.codeChallenge);
    console.log(`[OAuth] Login exitoso: ${result.email}`);

    const redirect = new URL(result.redirectUri);
    redirect.searchParams.set("code", authCode);
    redirect.searchParams.set("state", result.clientState);
    res.writeHead(302, { Location: redirect.toString() });
    return res.end();
  }

  // 6. Token exchange
  if (
    (url.pathname === "/oauth/token" || url.pathname === "/token") &&
    method === "POST"
  ) {
    const raw = await leerBody(req);
    const params = new URLSearchParams(raw);
    const code = params.get("code") ?? "";
    const codeVerifier = params.get("code_verifier") ?? "";

    const email = await canjearAuthCode(code, codeVerifier);
    if (!email) {
      console.log(`[OAuth] Token exchange FALLÓ`);
      return json(res, 400, { error: "invalid_grant" });
    }

    const token = generarToken(email);
    console.log(`[OAuth] Token emitido para: ${email}`);
    return json(res, 200, {
      access_token: token,
      token_type: "Bearer",
      expires_in: 28800,
    });
  }

  // 7. MCP endpoint
  if (url.pathname === `/${process.env.PATH_URL}` && ["POST", "GET", "DELETE"].includes(method)) {
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.replace("Bearer ", "");
    const usuario = verificarToken(token);

    console.log(`[AUTH] token recibido: "${token.substring(0, 20)}..."`);
    console.log(`[AUTH] usuario verificado: ${usuario}`);

    if (!usuario) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="${process.env.BASE_URL}", resource_metadata="${process.env.BASE_URL}/.well-known/oauth-protected-resource"`,
      });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }

    console.log(`[MCP] Request de: ${usuario}`);

    const modulos = await obtenerModulosUsuario(usuario);
    console.log(`[MCP] Módulos de ${usuario}: ${modulos.join(", ") || "ninguno"}`);

    const server = new McpServer({ name: "mcp-dqd", version: "1.0.0" });

    // Registrar siempre todos los módulos, pasando si el usuario tiene permiso
    registrarModuloAsistencia(server, usuario, asistenciaConfig, modulos.includes("asistencia"));
    // Para agregar un módulo nuevo: registrarModuloXxx(server, usuario, config, modulos.includes("xxx"));

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Error MCP:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    } finally {
      await server.close();
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

const PORT = parseInt(process.env.PORT || "3000");

console.log(`[CONFIG] JWT_SECRET presente: ${!!process.env.JWT_SECRET}`);
console.log(`[CONFIG] BASE_URL: ${process.env.BASE_URL}`);
console.log(`[CONFIG] PATH_URL: ${process.env.PATH_URL}`);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP corriendo en http://0.0.0.0:${PORT}`);
});
