// sync-marketshell — escribe precio y stock en el backoffice de Grupo Simpli
// (Directus), que es lo que publica marketshell.shell.com.ar.
//
// Es el port a la nube de `marketshell-feed/sync_simpli.py`, que corria en la
// PC de Fer. Motivo del port (10/09/2026): si esa PC estaba apagada, Shell
// quedaba congelado y nadie se enteraba.
//
// ⭐ POR QUE AHORA SE PUEDE, SI EL 01/09 SE DIJO QUE NO: el 429 que echo a la
// nube es del PORTAL PUBLICO de Shell (marketshell.shell.com.ar), no del
// Directus, que es OTRO host. Se confirmo el 10/09 con una funcion de prueba:
// `POST /auth/login` y una lectura autenticada de `cars_versions` dan 200
// desde Supabase Edge. Ojo con la pista falsa: `/server/ping` y `/collections`
// devuelven 403 de Cloudflare, pero TAMBIEN desde la red de la oficina — es
// por ruta, no por IP. `/items/...` y `/flows/trigger/...` pasan de todos lados.
//
// ⭐ 22/09/2026 — EL CATALOGO SALE DEL API DE PRECIOS, NO DE LA PLANILLA.
// Hasta ese dia venia del Apps Script (`modo=chequeo`, que lee la planilla),
// refrescada antes con `modo=aplicar`. Todo Shell dependia asi del web app de
// Google, que cada tanto devuelve su pagina de error HTML durante HORAS (el
// 22/09 de 00:12 a 09:12 AR): el guardia hacia bien en no publicar, pero Shell
// quedaba congelado por un problema ajeno. La planilla ya no publica nada
// (Shell se escribe por Directus desde el 08/09), asi que salio del camino:
// se lee directo `precios.titogonzalez.online/api/public/ofertas`, la misma
// fuente de la que la planilla copiaba. El refresco de la planilla quedo AL
// FINAL, como cortesia para Simpli: si Google falla se anota y no cambia nada.
// Matcheo con el mismo `_norm` del Apps Script. Verificado el 22/09: 38/38
// versiones de Simpli matchean y 0 diferencias contra lo publicado.
//
// Lo que NO hace, a proposito: colgar de su publicacion un modelo que Shell no
// muestra (el `--publicar` del script). Sumar un auto al feed de un tercero es
// una decision, se sigue haciendo a mano desde la PC.
//
// Deployar SIEMPRE con --no-verify-jwt: la llama el pg_cron sin header de auth.
// Gate: header `x-stock-secret`.

const TOLERANCIA = 100; // la plataforma redondea el importe a ~7 digitos
const API_PRECIOS = "https://precios.titogonzalez.online/api/public/ofertas";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Mismo gate que notify-marketshell, para no sumar un secret mas.
const GATE = Deno.env.get("STOCK_NOTIF_SECRET");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// El `_norm` del Apps Script del feed: sin acentos, sin "VW "/"Nuevo ", solo
// letras y numeros. Asi "VW Nuevo Polo ..." (portal de precios) y "Polo ..."
// (version de Simpli) dan la misma clave.
function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^\s*(vw|volkswagen)\s+/, "")
    .replace(/\bnuevo[as]?\s+/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

const plata = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");

// El web app de Apps Script tiene hipos sueltos: devuelve un 404 con la pagina
// de error de Google (HTML, no JSON) cuando se lo llama muy seguido. Se vio el
// 10/09/2026 probando esta funcion. Un 404 asi no significa que el feed este
// roto, asi que se reintenta antes de darlo por caido. Tambien se exige que la
// respuesta NO sea HTML: un 200 con la pagina de Google adentro romperia el
// JSON.parse de `chequeo` con un error mucho menos claro.
async function feed(url: string, token: string, modo: string, intentos = 3) {
  let ultimo = "";
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(
        url + "?token=" + encodeURIComponent(token) + "&modo=" + modo,
        { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) },
      );
      const txt = await r.text();
      if (!r.ok) {
        ultimo = "HTTP " + r.status + ": " + txt.slice(0, 150);
      } else if (txt.trimStart().startsWith("<")) {
        ultimo = "HTTP 200 pero devolvio HTML: " + txt.slice(0, 150);
      } else {
        return txt;
      }
    } catch (e) {
      ultimo = String(e).slice(0, 150);
    }
    if (i < intentos) await new Promise((r) => setTimeout(r, 2000 * i));
  }
  throw new Error("feed modo=" + modo + " fallo " + intentos + " veces - " + ultimo);
}

type Item = { modelo: string; precio: number | null; stock: number };

// Catalogo {modelo, precio, stock} directo del portal de precios. Precio =
// `oferta_fyf` (el contado de baratito, lo mismo que copiaba la planilla);
// stock = `stock` (OJO: `stock_disponible` es booleano). Se reintenta: un hipo
// suelto de Vercel no tiene que costar una hora de publicacion.
async function catalogo(intentos = 3): Promise<Item[]> {
  let ultimo = "";
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(API_PRECIOS, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = JSON.parse(txt);
      if (!j.ok) throw new Error("el portal dijo: " + (j.error ?? "?"));
      const ms = (j.modelos ?? []) as Array<Record<string, unknown>>;
      if (!ms.length) throw new Error("el portal devolvio 0 modelos");
      return ms.map((m) => {
        const p = Math.round(Number(m.oferta_fyf) || 0);
        const st = Number(m.stock) || 0;
        // Precio 0/vacio NO se publica (saldria como precio 0): queda null y se
        // deja el que haya. El stock va siempre.
        return { modelo: String(m.modelo), precio: p > 0 ? p : null, stock: st > 0 ? st : 0 };
      });
    } catch (e) {
      ultimo = String(e).slice(0, 150);
    }
    if (i < intentos) await new Promise((r) => setTimeout(r, 3000 * i));
  }
  throw new Error("API de precios fallo " + intentos + " veces - " + ultimo);
}

class Simpli {
  base: string;
  token = "";
  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  async call(path: string, method = "GET", body?: unknown) {
    const h: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
    if (this.token) h.Authorization = "Bearer " + this.token;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(this.base + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const txt = await r.text();
    const t = txt.trimStart();
    const j = t.startsWith("{") || t.startsWith("[") ? JSON.parse(txt) : txt;
    return { status: r.status, body: j };
  }

  async login(email: string, password: string) {
    const { status, body } = await this.call("/auth/login", "POST", { email, password });
    if (status !== 200) {
      throw new Error("login Simpli " + status + ": " + JSON.stringify(body).slice(0, 200));
    }
    this.token = (body as { data: { access_token: string } }).data.access_token;
  }

  async versiones() {
    const { status, body } = await this.call(
      "/items/cars_versions?limit=-1&fields[]=id&fields[]=name&fields[]=amount" +
        "&fields[]=stock&fields[]=currency&fields[]=model.id&fields[]=model.name",
    );
    if (status !== 200) throw new Error("cars_versions " + status);
    return (body as { data: Array<Record<string, unknown>> }).data;
  }

  async posts() {
    const { status, body } = await this.call(
      "/items/new_cars_posts?limit=-1&fields[]=id&fields[]=status&fields[]=title" +
        "&fields[]=car_model&fields[]=car_trims.cars_versions_id.id",
    );
    if (status !== 200) throw new Error("new_cars_posts " + status);
    return (body as { data: Array<Record<string, unknown>> }).data;
  }

  async patch(id: string, campos: Record<string, unknown>) {
    const { status, body } = await this.call("/items/cars_versions/" + id, "PATCH", campos);
    if (status !== 200) {
      throw new Error("PATCH " + status + ": " + JSON.stringify(body).slice(0, 200));
    }
  }
}

async function registrar(fila: Record<string, unknown>) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/marketshell_sync", {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(fila),
    });
  } catch (_) {
    // el registro no puede voltear el sync
  }
}

Deno.serve(async (req) => {
  let opts: Record<string, unknown> = {};
  try {
    opts = await req.json();
  } catch (_) {
    // body vacio
  }
  const dry = opts.dry === true;

  // Sin secret configurado NO se abre: una funcion que escribe en el portal de
  // un tercero no puede quedar publica por un env que falta.
  if (!GATE) return Response.json({ error: "STOCK_NOTIF_SECRET missing" }, { status: 500 });
  if (req.headers.get("x-stock-secret") !== GATE) {
    return Response.json({ error: "no autorizado" }, { status: 401 });
  }

  const MS_URL = Deno.env.get("MARKETSHELL_URL")!;
  const MS_TOKEN = Deno.env.get("MARKETSHELL_TOKEN")!;
  const out: Record<string, unknown> = { dry, origen: "edge" };

  try {
    // 1) Catalogo del portal de precios. Si no se puede leer, tira y no se
    //    publica nada: Shell se queda con lo ultimo, que estaba bien.
    const cat = await catalogo();
    out.catalogo = cat.length;

    const porNombre = new Map(cat.map((c) => [norm(c.modelo), c]));

    const s = new Simpli(Deno.env.get("SIMPLI_URL")!);
    await s.login(Deno.env.get("SIMPLI_USER")!, Deno.env.get("SIMPLI_PASS")!);
    const vers = await s.versiones();
    const posts = await s.posts();

    const pub = new Set<string>();
    for (const p of posts) {
      if (p.status !== "published") continue;
      for (const t of (p.car_trims ?? []) as Array<Record<string, unknown>>) {
        const v = t.cars_versions_id;
        if (typeof v === "string") pub.add(v);
        else if (v && typeof v === "object") pub.add((v as { id: string }).id);
      }
    }
    out.versiones = vers.length;
    out.publicadas = pub.size;

    const cambios: Array<[Record<string, unknown>, Record<string, unknown>, string[]]> = [];
    const sinMatch: string[] = [];
    const sinPublicar: string[] = [];
    const vistos = new Set<string>();
    const errores: string[] = [];

    for (const v of vers) {
      const c = porNombre.get(norm(v.name));
      if (!c) {
        sinMatch.push(String(v.name));
        continue;
      }
      vistos.add(norm(v.name));

      const campos: Record<string, unknown> = {};
      const det: string[] = [];
      const precio = c.precio;
      const stock = c.stock;
      if (precio != null && Math.abs(((v.amount as number) ?? 0) - precio) > TOLERANCIA) {
        campos.amount = Math.round(precio);
        det.push("precio " + plata((v.amount as number) ?? 0) + " -> " + plata(campos.amount as number));
      }
      if (stock != null && ((v.stock as number) ?? 0) !== stock) {
        campos.stock = stock;
        det.push("stock " + v.stock + " -> " + stock);
      }
      if (!v.currency) {
        campos.currency = "ARS";
        det.push("moneda -> ARS");
      }
      if (Object.keys(campos).length) cambios.push([v, campos, det]);

      if (!pub.has(v.id as string) && (stock ?? 0) > 0) {
        sinPublicar.push(v.name + " (" + stock + " unidades)");
      }
    }

    const detalle: string[] = [];
    for (const [v, campos, det] of cambios) {
      detalle.push(v.name + ": " + det.join(" · "));
      if (!dry) {
        try {
          await s.patch(v.id as string, campos);
        } catch (e) {
          errores.push(v.name + ": " + String(e).slice(0, 150));
        }
      }
    }

    const faltan = [...porNombre.entries()]
      .filter(([k, c]) => !vistos.has(k) && ((c.stock as number) ?? 0) > 0)
      .map(([, c]) => String(c.modelo));

    out.a_corregir = cambios.length;
    out.aplicados = dry ? 0 : cambios.length - errores.length;
    out.cambios = detalle;
    out.sin_match = sinMatch;
    out.sin_ficha_con_stock = faltan;
    // Colgarlos de su publicacion es decision manual: `sync_simpli.py --publicar`.
    out.cargados_sin_publicar = sinPublicar;
    out.errores = errores;
    out.ok = errores.length === 0;

    // 2) Recien ahora, y sin que cuente para el resultado: refrescar la planilla
    //    de Simpli. Ya no publica nada, pero es lo que ellos miran. Si el web
    //    app de Google esta caido se anota y listo.
    if (!dry) {
      try {
        await feed(MS_URL, MS_TOKEN, "aplicar", 2);
        out.planilla_refrescada = true;
      } catch (e) {
        out.planilla_refrescada = false;
        out.error_planilla = String(e).slice(0, 300);
      }
    }

    await registrar({
      ok: out.ok,
      aplicados: out.aplicados,
      a_corregir: cambios.length,
      sin_match: sinMatch.length,
      sin_publicar: sinPublicar.length,
      abortado: dry ? "dry-run" : null,
      detalle: out,
    });
    return Response.json(out, { status: 200 });
  } catch (e) {
    out.ok = false;
    out.error = String(e).slice(0, 500);
    await registrar({ ok: false, abortado: String(e).slice(0, 300), detalle: out });
    return Response.json(out, { status: 200 });
  }
});
