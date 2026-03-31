import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import sql from "mssql";
import * as dotenv from "dotenv";
import { z } from "zod";
import * as http from "http";

dotenv.config();

// --- DB -----------------------------------------------------------------------

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

// --- Mapa dispositivos → proyecto --------------------------------------------

const PROYECTOS: Record<string, string[]> = {
  "DP SAENZ PEÑA":          ["Deposito Saenz Peña", "Desposito Saenz Peña"],
  "ED - PDI":               [],
  "OF - CABA":              ["Oficina Buenos Aires"],
  "OF - CORDOBA":           [
    "Piso 5 Cordoba", "Piso 5 Cordoba Entrada", "Piso 5 Cordoba Salida",
    "Piso 5 Deposito de documentos", "Piso8_Entrada.7", "Piso8_salida.6"
  ],
  "PS - ARAUCO I":          ["PS Arauco 1", "PS Arauco 2", "PS Arauco 3", "PS Arauco 4"],
  "PS - ARCOR RECREO I":    ["PS Recreo 1"],
  "PS - EL QUEMADO":        ["El Quemado 1", "El Quemado 2", "El Quemado 3", "El Quemado 4", "Coworking Mendoza"],
  "PS - ING JUAREZ":        [],
  "PS - JUNIN":             ["PS Junin 1", "PS Junin 3"],
  "PS - LA PERLA DE CHACO": ["PS La Perla 1"],
  "PS - LINCOLN":           ["PS Lincoln 2", "PS Lincoln 4"],
  "PS - QUITILIPI":         ["PS Quitilipi 1", "PS Quitilipi 2"],
  "PS - TRES ISLETAS":      ["PS Tres Isletas 1", "PS Tres Isletas 2", "PS Tres Isletas 4"],
};

function dispositivosDeProyecto(nombre: string): string[] {
  const key = Object.keys(PROYECTOS).find(
    k => k.toLowerCase() === nombre.toLowerCase()
  );
  return key ? PROYECTOS[key] : [];
}

function bindDispositivos(req: sql.Request, dispositivos: string[], prefix = "d"): string {
  return dispositivos.map((d, i) => {
    req.input(`${prefix}${i}`, sql.NVarChar, d);
    return `@${prefix}${i}`;
  }).join(", ");
}

const ACTIVO = `(n.egreso IS NULL OR n.egreso > GETDATE())`;
const FECHA_FILTRO = (fecha?: string) => fecha ? "@fecha" : "CAST(GETDATE() AS DATE)";

// --- Registro de tools -------------------------------------------------------

function registrarTools(server: McpServer) {

  // TOOL 1: Listar proyectos
  server.tool(
    "listar_proyectos",
    "Lista todos los proyectos de la empresa.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(Object.keys(PROYECTOS)) }],
    })
  );

  // TOOL 2: Presentes por proyecto
  server.tool(
    "presentes_por_proyecto",
    "Cantidad de empleados presentes en cada proyecto en una fecha. Presente = marcó en algún reloj del proyecto. Sin fecha usa hoy. Sin proyecto devuelve todos.",
    {
      fecha:    z.string().optional().describe("YYYY-MM-DD. Default: hoy."),
      proyecto: z.string().optional().describe("Nombre del proyecto. Default: todos."),
    },
    async ({ fecha, proyecto }) => {
      const pool = await getPool();

      if (proyecto) {
        const dispositivos = dispositivosDeProyecto(proyecto);
        if (!dispositivos.length) {
          await pool.close();
          return { content: [{ type: "text", text: `Proyecto "${proyecto}" no tiene relojes asociados o no existe. Usá listar_proyectos.` }] };
        }
        const req = pool.request();
        if (fecha) req.input("fecha", sql.Date, fecha);
        const placeholders = bindDispositivos(req, dispositivos);
        const result = await req.query(`
          SELECT COUNT(DISTINCT id_empleado) AS presentes
          FROM dbo.registros_acceso
          WHERE nombre_dispositivo IN (${placeholders})
            AND fecha_acceso = ${FECHA_FILTRO(fecha)}
        `);
        await pool.close();
        return {
          content: [{ type: "text", text: JSON.stringify({
            proyecto, fecha: fecha ?? "hoy", presentes: result.recordset[0]?.presentes ?? 0
          })}],
        };
      }

      // Todos los proyectos
      const resumen: { proyecto: string; presentes: number }[] = [];
      for (const [nombre, dispositivos] of Object.entries(PROYECTOS)) {
        if (!dispositivos.length) {
          resumen.push({ proyecto: nombre, presentes: 0 });
          continue;
        }
        const req = pool.request();
        if (fecha) req.input("fecha", sql.Date, fecha);
        const placeholders = bindDispositivos(req, dispositivos);
        const result = await req.query(`
          SELECT COUNT(DISTINCT id_empleado) AS presentes
          FROM dbo.registros_acceso
          WHERE nombre_dispositivo IN (${placeholders})
            AND fecha_acceso = ${FECHA_FILTRO(fecha)}
        `);
        resumen.push({ proyecto: nombre, presentes: result.recordset[0]?.presentes ?? 0 });
      }
      await pool.close();
      return {
        content: [{ type: "text", text: JSON.stringify({ fecha: fecha ?? "hoy", proyectos: resumen }) }],
      };
    }
  );

  // TOOL 3: Detalle presentes
  server.tool(
    "detalle_presentes",
    "Lista de empleados presentes en un proyecto en una fecha dada, con hora de entrada y convenio.",
    {
      proyecto: z.string().describe("Nombre del proyecto."),
      fecha:    z.string().optional().describe("YYYY-MM-DD. Default: hoy."),
    },
    async ({ proyecto, fecha }) => {
      const dispositivos = dispositivosDeProyecto(proyecto);
      if (!dispositivos.length) {
        return { content: [{ type: "text", text: `Proyecto "${proyecto}" no tiene relojes asociados o no existe. Usá listar_proyectos.` }] };
      }
      const pool = await getPool();
      const req = pool.request();
      if (fecha) req.input("fecha", sql.Date, fecha);
      const placeholders = bindDispositivos(req, dispositivos);
      const result = await req.query(`
        SELECT
          COALESCE(n.apellido + ', ' + n.nombre, r.nombre) AS empleado,
          n.convenio,
          MIN(r.hora_acceso) AS hora_entrada,
          MAX(r.hora_acceso) AS ultima_marca,
          COUNT(*)           AS cantidad_marcas
        FROM dbo.registros_acceso r
        LEFT JOIN dbo.nomina n ON n.dni = r.id_empleado AND ${ACTIVO}
        WHERE r.nombre_dispositivo IN (${placeholders})
          AND r.fecha_acceso = ${FECHA_FILTRO(fecha)}
        GROUP BY r.id_empleado, n.apellido, n.nombre, n.convenio, r.nombre
        ORDER BY hora_entrada
      `);
      await pool.close();
      return {
        content: [{ type: "text", text: JSON.stringify({
          proyecto, fecha: fecha ?? "hoy", empleados: result.recordset
        })}],
      };
    }
  );

  // TOOL 4: Ausentes por proyecto
  server.tool(
    "ausentes_por_proyecto",
    "Empleados que faltaron en un proyecto: tienen ese proyecto en nómina y no marcaron en ningún reloj ese día.",
    {
      proyecto: z.string().describe("Nombre del proyecto (debe coincidir con el valor en nómina)."),
      fecha:    z.string().optional().describe("YYYY-MM-DD. Default: hoy."),
    },
    async ({ proyecto, fecha }) => {
      const pool = await getPool();
      const req = pool.request();
      req.input("proyecto", sql.NVarChar, proyecto);
      if (fecha) req.input("fecha", sql.Date, fecha);
      const result = await req.query(`
        SELECT
          n.apellido + ', ' + n.nombre AS empleado,
          n.dni,
          n.legajo,
          n.convenio
        FROM dbo.nomina n
        WHERE ${ACTIVO}
          AND n.proyecto = @proyecto
          AND n.dni NOT IN (
            SELECT DISTINCT id_empleado
            FROM dbo.registros_acceso
            WHERE fecha_acceso = ${FECHA_FILTRO(fecha)}
              AND id_empleado IS NOT NULL
          )
        ORDER BY n.apellido, n.nombre
      `);
      await pool.close();
      return {
        content: [{ type: "text", text: JSON.stringify({
          proyecto, fecha: fecha ?? "hoy",
          cantidad_ausentes: result.recordset.length,
          ausentes: result.recordset
        })}],
      };
    }
  );

  // TOOL 5: Ranking ausencias semana
  server.tool(
    "ranking_ausencias_semana",
    "Top de empleados con más ausencias desde el lunes hasta hoy. Ausente = tiene un proyecto en nómina y no marcó ese día.",
    {
      proyecto: z.string().optional().describe("Filtrar por proyecto en nómina. Default: toda la empresa."),
      top:      z.number().optional().describe("Cantidad de empleados a mostrar. Default: 10."),
    },
    async ({ proyecto, top = 10 }) => {
      const pool = await getPool();
      const req = pool.request();
      req.input("top", sql.Int, top);
      if (proyecto) req.input("proyecto", sql.NVarChar, proyecto);
      const whereProyecto = proyecto ? "AND n.proyecto = @proyecto" : "";

      const result = await req.query(`
        WITH dias AS (
          SELECT CAST(
            DATEADD(DAY, v.n, DATEADD(DAY, 2 - DATEPART(WEEKDAY, GETDATE()), CAST(GETDATE() AS DATE)))
          AS DATE) AS dia
          FROM (VALUES(0),(1),(2),(3),(4)) v(n)
          WHERE DATEADD(DAY, v.n, DATEADD(DAY, 2 - DATEPART(WEEKDAY, GETDATE()), CAST(GETDATE() AS DATE))) <= CAST(GETDATE() AS DATE)
            AND DATEPART(WEEKDAY, DATEADD(DAY, v.n, DATEADD(DAY, 2 - DATEPART(WEEKDAY, GETDATE()), CAST(GETDATE() AS DATE)))) NOT IN (1, 7)
        ),
        combinados AS (
          SELECT n.dni, n.apellido, n.nombre, n.proyecto, n.convenio, d.dia
          FROM dbo.nomina n CROSS JOIN dias d
          WHERE ${ACTIVO} ${whereProyecto}
        ),
        marcas AS (
          SELECT DISTINCT id_empleado, fecha_acceso
          FROM dbo.registros_acceso
          WHERE fecha_acceso IN (SELECT dia FROM dias)
        )
        SELECT TOP (@top)
          c.apellido + ', ' + c.nombre AS empleado,
          c.proyecto,
          c.convenio,
          COUNT(*) AS dias_ausente
        FROM combinados c
        LEFT JOIN marcas m ON m.id_empleado = c.dni AND m.fecha_acceso = c.dia
        WHERE m.id_empleado IS NULL
        GROUP BY c.dni, c.apellido, c.nombre, c.proyecto, c.convenio
        ORDER BY dias_ausente DESC
      `);
      await pool.close();
      return {
        content: [{ type: "text", text: JSON.stringify({ periodo: "semana_actual", data: result.recordset }) }],
      };
    }
  );

  // TOOL 6: Ranking ausencias mes
  server.tool(
    "ranking_ausencias_mes",
    "Top de empleados con más ausencias en el mes actual.",
    {
      proyecto: z.string().optional().describe("Filtrar por proyecto en nómina. Default: toda la empresa."),
      top:      z.number().optional().describe("Cantidad de empleados a mostrar. Default: 10."),
    },
    async ({ proyecto, top = 10 }) => {
      const pool = await getPool();
      const req = pool.request();
      req.input("top", sql.Int, top);
      if (proyecto) req.input("proyecto", sql.NVarChar, proyecto);
      const whereProyecto = proyecto ? "AND n.proyecto = @proyecto" : "";

      const result = await req.query(`
        WITH dias AS (
          SELECT CAST(
            DATEADD(DAY, n.number, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
          AS DATE) AS dia
          FROM master.dbo.spt_values n
          WHERE n.type = 'P'
            AND DATEADD(DAY, n.number, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) <= CAST(GETDATE() AS DATE)
            AND DATEADD(DAY, n.number, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) < DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()) + 1, 1)
            AND DATEPART(WEEKDAY, DATEADD(DAY, n.number, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))) NOT IN (1, 7)
        ),
        combinados AS (
          SELECT n.dni, n.apellido, n.nombre, n.proyecto, n.convenio, d.dia
          FROM dbo.nomina n CROSS JOIN dias d
          WHERE ${ACTIVO} ${whereProyecto}
        ),
        marcas AS (
          SELECT DISTINCT id_empleado, fecha_acceso
          FROM dbo.registros_acceso
          WHERE fecha_acceso IN (SELECT dia FROM dias)
        )
        SELECT TOP (@top)
          c.apellido + ', ' + c.nombre AS empleado,
          c.proyecto,
          c.convenio,
          COUNT(*) AS dias_ausente
        FROM combinados c
        LEFT JOIN marcas m ON m.id_empleado = c.dni AND m.fecha_acceso = c.dia
        WHERE m.id_empleado IS NULL
        GROUP BY c.dni, c.apellido, c.nombre, c.proyecto, c.convenio
        ORDER BY dias_ausente DESC
      `);
      await pool.close();
      return {
        content: [{ type: "text", text: JSON.stringify({ periodo: "mes_actual", data: result.recordset }) }],
      };
    }
  );

  // TOOL 7: Directos e indirectos
  server.tool(
    "directos_indirectos",
    "Empleados directos (UOCRA CCT 76/75) e indirectos (FUERA DE CONVENIO) presentes por proyecto. Proyecto determinado por nómina.",
    {
      fecha:    z.string().optional().describe("YYYY-MM-DD. Default: hoy."),
      proyecto: z.string().optional().describe("Nombre del proyecto en nómina. Default: todos."),
    },
    async ({ fecha, proyecto }) => {
      const pool = await getPool();
      const req = pool.request();
      if (fecha) req.input("fecha", sql.Date, fecha);
      if (proyecto) req.input("proyecto", sql.NVarChar, proyecto);
      const whereProyecto = proyecto ? "AND n.proyecto = @proyecto" : "";

      const result = await req.query(`
        SELECT
          n.proyecto,
          COUNT(DISTINCT CASE WHEN n.convenio = 'UOCRA CCT 76/75'  THEN n.dni END) AS directos,
          COUNT(DISTINCT CASE WHEN n.convenio = 'FUERA DE CONVENIO' THEN n.dni END) AS indirectos,
          COUNT(DISTINCT n.dni) AS total
        FROM dbo.nomina n
        INNER JOIN dbo.registros_acceso r
          ON r.id_empleado = n.dni
          AND r.fecha_acceso = ${FECHA_FILTRO(fecha)}
        WHERE ${ACTIVO} ${whereProyecto}
        GROUP BY n.proyecto
        ORDER BY n.proyecto
      `);
      await pool.close();
      return {
        content: [{ type: "text", text: JSON.stringify({ fecha: fecha ?? "hoy", data: result.recordset }) }],
      };
    }
  );
}

// --- HTTP Server --------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  if (req.url === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    // Nueva instancia por request: evita el error "Already connected to a transport"
    const server = new McpServer({ name: "mcp-asistencia", version: "1.0.0" });
    registrarTools(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Error manejando request MCP:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    } finally {
      await server.close();
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

const PORT = parseInt(process.env.PORT || "3000");
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP asistencia corriendo en http://0.0.0.0:${PORT}/mcp`);
});
