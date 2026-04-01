import sql from "mssql";
import * as dotenv from "dotenv";

dotenv.config();

const poolPromise = new sql.ConnectionPool({
  server: process.env.MSSQL_HOST!,
  port: parseInt(process.env.MSSQL_PORT || "1433"),
  database: process.env.MSSQL_PERMISOS_DATABASE!,
  user: process.env.MSSQL_USER!,
  password: process.env.MSSQL_PASSWORD!,
  options: { trustServerCertificate: true },
}).connect();

export async function obtenerModulosUsuario(email: string): Promise<string[]> {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("email", sql.NVarChar, email.toLowerCase())
    .query<{ modulo: string }>("SELECT modulo FROM permisos WHERE LOWER(email) = @email");
  return result.recordset.map((r) => r.modulo);
}
