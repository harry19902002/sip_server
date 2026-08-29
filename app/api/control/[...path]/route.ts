const controlApiUrl = process.env.FREESWITCH_API_URL ?? "http://127.0.0.1:3001";
const controlApiKey = process.env.FREESWITCH_API_KEY ?? "";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, context: RouteContext) {
  if (!controlApiKey) {
    return Response.json({ error: "control_api_not_configured" }, { status: 503 });
  }

  const { path } = await context.params;
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`/api/v1/${path.map(encodeURIComponent).join("/")}`, controlApiUrl);
  targetUrl.search = incomingUrl.search;

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      "x-api-key": controlApiKey,
    },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    cache: "no-store",
  });

  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const GET = proxy;
export const POST = proxy;
