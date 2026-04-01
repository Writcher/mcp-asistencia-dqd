import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import sql from "mssql";
import * as dotenv from "dotenv";
import { z } from "zod";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// --- Config ------------------------------------------------------------------

const config = JSON.parse(
  readFileSync(resolve(__dirname, "..", "config.json"), "utf-8")
);
const PROYECTOS: Record<string, string[]> = config.proyectos;
const SCHEMA_BASE: string = config.schema_description;

const SCHEMA_DESCRIPTION = `${SCHEMA_BASE}

== MAPEO DISPOSITIVOS → PROYECTO ==
Los dispositivos (relojes) se agrupan por proyecto. Este mapeo NO está en la DB:
${Object.entries(PROYECTOS).map(([k, v]) => `  ${k}: ${v.length ? v.join(", ") : "(sin dispositivos)"}`).join("\n")}`;

// --- DB ----------------------------------------------------------------------

const dbConfig: sql.config = {
  server: process.env.MSSQL_HOST!,
  port: parseInt(process.env.MSSQL_PORT || "1433"),
  database: process.env.MSSQL_DATABASE!,
  user: process.env.MSSQL_USER!,
  password: process.env.MSSQL_PASSWORD!,
  options: { trustServerCertificate: true },
};

async function getPool() {
  return sql.connect(dbConfig);
}

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

// --- Tools -------------------------------------------------------------------

function registrarTools(server: McpServer, usuario: string) {
  server.tool(
    "listar_proyectos",
    "Lista todos los proyectos de la empresa con sus dispositivos (relojes) asociados.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(PROYECTOS, null, 2) }],
    })
  );

  server.tool(
    "consulta_sql",
    `Ejecuta una consulta SELECT de solo lectura contra la base de datos de asistencia.
Usá esta herramienta para responder cualquier pregunta sobre asistencia, presentes, ausentes, empleados, etc.

${SCHEMA_DESCRIPTION}`,
    { query: z.string().describe("Consulta SQL SELECT a ejecutar. Solo se permiten SELECT.") },
    async ({ query }) => {
      const trimmed = query.trim();
      if (!/^SELECT\b/i.test(trimmed)) {
        return { content: [{ type: "text", text: "Error: Solo se permiten consultas SELECT." }], isError: true };
      }
      if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|DENY)\b/i.test(trimmed)) {
        return { content: [{ type: "text", text: "Error: La consulta contiene operaciones no permitidas." }], isError: true };
      }

      console.log(`[SQL] ${usuario} → ${trimmed}`);

      const pool = await getPool();
      try {
        const result = await pool.request().query(trimmed);
        await pool.close();
        return {
          content: [{ type: "text", text: JSON.stringify({ filas: result.recordset.length, datos: result.recordset }) }],
        };
      } catch (err: any) {
        await pool.close();
        return { content: [{ type: "text", text: `Error SQL: ${err.message}` }], isError: true };
      }
    }
  );
}

// --- HTTP Server -------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const method = req.method ?? "GET";

  // 1. Protected Resource Metadata — Claude lo llama primero ante un 401
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    return json(res, 200, {
      resource: process.env.BASE_URL,
      authorization_servers: [process.env.BASE_URL],
      bearer_methods_supported: ["header"],
    });
  }

  // 2. Authorization Server Metadata — Claude descubre los endpoints
  if (url.pathname === "/.well-known/oauth-authorization-server") {
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

  // 3. Dynamic Client Registration — Claude se registra acá
  if (url.pathname === "/oauth/register" && method === "POST") {
    const raw = await leerBody(req);
    const body = JSON.parse(raw);
    const client = registrarCliente(body);
    console.log(`[DCR] Cliente registrado: ${client.client_id}`);
    return json(res, 201, client);
  }

  // 4. Authorize — Claude redirige al usuario acá, vos redirigís a Azure
  if (url.pathname === "/oauth/authorize" && method === "GET") {
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const clientState = url.searchParams.get("state") ?? "";
    const { location } = await generarUrlAzure(redirectUri, clientState);
    res.writeHead(302, { Location: location });
    return res.end();
  }

  // 5. Callback de Azure — Azure redirige acá después del login
  if (url.pathname === "/oauth/callback" && method === "GET") {
    const code = url.searchParams.get("code") ?? "";
    const azureState = url.searchParams.get("state") ?? "";

    const result = await manejarCallback(code, azureState);
    if (!result) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Error de autenticación. Intentá de nuevo.");
    }

    const authCode = generarAuthCode(result.email);
    console.log(`[OAuth] Login exitoso: ${result.email}`);

    const redirect = new URL(result.redirectUri);
    redirect.searchParams.set("code", authCode);
    redirect.searchParams.set("state", result.clientState);
    res.writeHead(302, { Location: redirect.toString() });
    return res.end();
  }

  // 6. Token exchange — Claude intercambia el code por el JWT
  if (url.pathname === "/oauth/token" && method === "POST") {
    const raw = await leerBody(req);
    const params = new URLSearchParams(raw);
    const code = params.get("code") ?? "";

    const email = canjearAuthCode(code);
    if (!email) {
      return json(res, 400, { error: "invalid_grant" });
    }

    const token = generarToken(email);
    return json(res, 200, {
      access_token: token,
      token_type: "Bearer",
      expires_in: 28800,
    });
  }

  // 7. MCP endpoint
  if (url.pathname === `/${process.env.SECRET_PATH}` && ["POST", "GET", "DELETE"].includes(method)) {
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.replace("Bearer ", "");
    const usuario = verificarToken(token);

    if (!usuario) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="${process.env.BASE_URL}", resource_metadata="${process.env.BASE_URL}/.well-known/oauth-protected-resource"`,
      });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }

    console.log(`[MCP] Request de: ${usuario}`);

    const server = new McpServer({ name: "mcp-asistencia", version: "1.0.0" });
    registrarTools(server, usuario);
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
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP asistencia corriendo en http://0.0.0.0:${PORT}`);
});
