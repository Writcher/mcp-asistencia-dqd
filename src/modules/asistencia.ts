import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sql from "mssql";
import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

const dbConfig: sql.config = {
  server: process.env.MSSQL_HOST!,
  port: parseInt(process.env.MSSQL_PORT || "1433"),
  database: process.env.MSSQL_ASISTENCIA_DATABASE!,
  user: process.env.MSSQL_USER!,
  password: process.env.MSSQL_PASSWORD!,
  options: { trustServerCertificate: true },
};

async function getPool() {
  return sql.connect(dbConfig);
}

export interface AsistenciaConfig {
  proyectos: Record<string, string[]>;
  schema_description: string;
}

export function registrarModuloAsistencia(server: McpServer, usuario: string, config: AsistenciaConfig) {
  const proyectos = config.proyectos;
  const schemaDescription = `${config.schema_description}

== MAPEO DISPOSITIVOS → PROYECTO ==
Los dispositivos (relojes) se agrupan por proyecto. Este mapeo NO está en la DB:
${Object.entries(proyectos).map(([k, v]) => `  ${k}: ${v.length ? v.join(", ") : "(sin dispositivos)"}`).join("\n")}`;

  server.tool(
    "listar_proyectos",
    "Lista todos los proyectos de la empresa con sus dispositivos (relojes) asociados.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(proyectos, null, 2) }],
    })
  );

  server.tool(
    "consulta_sql",
    `Ejecuta una consulta SELECT de solo lectura contra la base de datos de asistencia.
Usá esta herramienta para responder cualquier pregunta sobre asistencia, presentes, ausentes, empleados, etc.

${schemaDescription}`,
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
