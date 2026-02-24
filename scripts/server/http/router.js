function normalizeMethod(methodLike) {
  return String(methodLike || "GET").trim().toUpperCase();
}

function normalizePath(pathLike) {
  const raw = String(pathLike || "/").trim();
  if (!raw) return "/";
  if (!raw.startsWith("/")) return `/${raw}`;
  return raw;
}

export function createHttpRouter(routesLike = []) {
  const routes = [];

  function register(routeLike) {
    const route = routeLike && typeof routeLike === "object" ? routeLike : {};
    const method = normalizeMethod(route.method);
    const path = normalizePath(route.path);
    const handler = route.handler;
    if (typeof handler !== "function") {
      throw new Error(`Invalid handler for route ${method} ${path}`);
    }
    routes.push({ method, path, handler });
  }

  for (const route of Array.isArray(routesLike) ? routesLike : []) {
    register(route);
  }

  async function dispatch(req, res) {
    const method = normalizeMethod(req?.method);
    const pathname = normalizePath(new URL(req?.url ?? "/", "http://localhost").pathname);
    const route = routes.find((item) => item.method === method && item.path === pathname);
    if (!route) return false;
    await route.handler(req, res);
    return true;
  }

  return {
    register,
    dispatch,
    routes,
  };
}
